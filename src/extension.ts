import * as vscode from 'vscode';
import OpenAI from 'openai';
import * as glob from 'glob';
import { minimatch } from 'minimatch';
import * as fs from 'fs';
import * as path from 'path';

class ContextManager {
    private includedFiles: Set<string> = new Set();
    private excludedFiles: Set<string> = new Set();
    private readonly maxFiles: number;
    private readonly inclusions: string[];
    private readonly exclusions: string[];

    constructor() {
        const config = vscode.workspace.getConfiguration('falalo');
        this.maxFiles = config.get('maxContextFiles', 500);
        this.inclusions = config.get('contextInclusions', []);
        this.exclusions = config.get('contextExclusions', []);
        this.updateContext();
    }

    private async updateContext() {
        if (!vscode.workspace.workspaceFolders) {
            return;
        }

        const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
        const files = await glob.glob('**/*', { 
            cwd: workspaceRoot,
            nodir: true,
            ignore: this.exclusions
        });

        this.includedFiles.clear();
        this.excludedFiles.clear();
        for (const file of files) {
            if (this.shouldIncludeFile(file) && this.includedFiles.size < this.maxFiles) {
                this.includedFiles.add(file);
            }
        }
    }

    private shouldIncludeFile(file: string): boolean {
        return this.inclusions.some(pattern => minimatch(file, pattern)) &&
               !this.exclusions.some(pattern => minimatch(file, pattern));
    }

    public getIncludedFiles(): string[] {
        return Array.from(this.includedFiles);
    }

    public getExcludedFiles(): string[] {
        return Array.from(this.excludedFiles);
    }

    public async includeFile(file: string) {
        if (this.includedFiles.size >= this.maxFiles) {
            throw new Error(`Cannot include more than ${this.maxFiles} files in context`);
        }
        this.includedFiles.add(file);
        this.excludedFiles.delete(file);
    }

    public excludeFile(file: string) {
        this.includedFiles.delete(file);
        this.excludedFiles.add(file);
    }

    public removeFromContext(file: string) {
        this.includedFiles.delete(file);
        this.excludedFiles.delete(file);
    }
}

class ChatViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'falaloChat';
    private _view?: vscode.WebviewView;
    private openai: OpenAI;
    private fileViewProvider?: FileViewProvider;
    private terminalOutput: string = '';
    private readonly maxRetries: number = 4;
    private activeTerminals: Map<string, vscode.Terminal> = new Map();

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _extensionContext: vscode.ExtensionContext,
        private readonly contextManager: ContextManager
    ) {
        const config = vscode.workspace.getConfiguration('falalo');
        const apiKey = config.get('openaiApiKey', '');
        this.openai = new OpenAI({
            apiKey: apiKey,
            dangerouslyAllowBrowser: true
        });
    }

    public setFileViewProvider(provider: FileViewProvider) {
        this.fileViewProvider = provider;
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                this._extensionUri
            ]
        };

        webviewView.webview.html = this._getHtmlForWebview();

        webviewView.webview.onDidReceiveMessage(async message => {
            switch (message.type) {
                case 'message':
                    await this.handleUserMessage(message.text);
                    break;
            }
        });
    }

    private async executeCommandWithRetry(command: string, retryCount = 0): Promise<boolean> {
        try {
            return new Promise<boolean>((resolve) => {
                const terminalId = `Falalo-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
                const terminal = vscode.window.createTerminal({
                    name: terminalId,
                    shellPath: process.platform === 'win32' ? 'cmd.exe' : '/bin/bash'
                });

                this.activeTerminals.set(terminalId, terminal);

                // Clean up terminal and check exit code when it closes
                const disposable = vscode.window.onDidCloseTerminal(async closedTerminal => {
                    if (closedTerminal === terminal) {
                        disposable.dispose();
                        this.activeTerminals.delete(terminalId);
                        try {
                            // Read the captured exit code
                            const fs = require('fs');
                            const capturedExitCode = await fs.promises.readFile(`/tmp/${terminalId}_exit_code`, 'utf8');
                            const actualExitCode = parseInt(capturedExitCode.trim(), 10);
                            const output = await fs.promises.readFile(`/tmp/${terminalId}_output`, 'utf8');

                            if (actualExitCode !== 0) {
                                if (retryCount < this.maxRetries - 1) {
                                    this.addMessageToChat('assistant', `⚠️ Command failed with exit code ${actualExitCode}, retrying (attempt ${retryCount + 2}/${this.maxRetries})...`);
                                    await new Promise(resolve => setTimeout(resolve, 2000));
                                    const success = await this.executeCommandWithRetry(command, retryCount + 1);
                                    resolve(success);
                                } else {
                                    this.addMessageToChat('assistant', `❌ Command failed after ${this.maxRetries} attempts. Skipping to next step.`);
                                    resolve(false);
                                }
                            } else {
                                this.terminalOutput = `${this.terminalOutput}\n$ ${command} (Terminal: ${terminalId})\n${output}\nExit code: ${actualExitCode}\n`;
                                this.addMessageToChat('assistant', `✅ Command executed successfully in terminal ${terminalId}`);
                                resolve(true);
                            }
                        } catch (error) {
                            if (retryCount < this.maxRetries - 1) {
                                this.addMessageToChat('assistant', `⚠️ Command failed, retrying (attempt ${retryCount + 2}/${this.maxRetries})...`);
                                await new Promise(resolve => setTimeout(resolve, 2000));
                                const success = await this.executeCommandWithRetry(command, retryCount + 1);
                                resolve(success);
                            } else {
                                this.addMessageToChat('assistant', `❌ Command failed after ${this.maxRetries} attempts. Skipping to next step.`);
                                resolve(false);
                            }
                        }
                    }
                });

                terminal.show(true); // true means preserve focus
                // Wrap the command to capture its output and exit code
                const wrappedCommand = process.platform === 'win32' 
                    ? `${command} > %TEMP%\\${terminalId}_output 2>&1 & echo %ERRORLEVEL% > %TEMP%\\${terminalId}_exit_code & exit`
                    : `${command} 2>&1 | tee /tmp/${terminalId}_output; echo $? > /tmp/${terminalId}_exit_code; exit`;
                terminal.sendText(wrappedCommand);

                // Log the command start
                this.addMessageToChat('assistant', `🚀 Started command in terminal ${terminalId}: ${command}`);
            });
        } catch (error) {
            if (retryCount < this.maxRetries - 1) {
                this.addMessageToChat('assistant', `⚠️ Command failed to start, retrying (attempt ${retryCount + 2}/${this.maxRetries})...`);
                await new Promise(resolve => setTimeout(resolve, 2000));
                return this.executeCommandWithRetry(command, retryCount + 1);
            } else {
                this.addMessageToChat('assistant', `❌ Command failed to start after ${this.maxRetries} attempts. Skipping to next step.`);
                return false;
            }
        }
    }

    private async handleUserMessage(text: string) {
        try {
            if (!this._view) {
                return;
            }

            // Add user message to chat
            this.addMessageToChat('user', text);

            // Get included files for context
            const includedFiles = this.contextManager.getIncludedFiles();
            const excludedFiles = this.contextManager.getExcludedFiles();

            // Prepare context information
            let contextInfo = '';
            if (includedFiles.length > 0) {
                contextInfo += '\nIncluded files in context:\n' + includedFiles.join('\n');
            }
            if (excludedFiles.length > 0) {
                contextInfo += '\nExcluded files from context:\n' + excludedFiles.join('\n');
            }
            if (this.terminalOutput) {
                contextInfo += '\nRecent terminal output:\n' + this.terminalOutput;
            }

            // Stage 1: Planning Phase
            const planningInstructions = `User request: "${text}"

Create a clear, step-by-step implementation plan.
IMPORTANT: Number each step clearly as "Step 1:", "Step 2:", etc.

Workspace context:${contextInfo}

Focus on:
1-Creating the actual files and code
2-Making it look good
3-Making it extensive and detailed
4-Making sure all the pathways are correct`;

            // Get plan from AI
            const planCompletion = await this.openai.chat.completions.create({
                model: 'o3-mini',
                messages: [
                    { 
                        role: 'system', 
                        content: 'You are a software development planner. Number each step clearly as "Step 1:", "Step 2:", etc. Keep steps clear and actionable.' 
                    },
                    { role: 'user', content: text },
                    { role: 'assistant', content: 'I will help you with that. Let me create a clear, numbered plan.' },
                    { role: 'user', content: planningInstructions }
                ],
            });

            const plan = planCompletion.choices[0].message.content || '';
            
            // Show the plan to the user
            this.addMessageToChat('assistant', '🔍 Planning Phase:\n\n' + plan);

            // Stage 2: Execution Phase
            // Extract steps using a more flexible pattern
            const stepRegex = /(?:Step\s*(\d+)[:.]\s*|^(\d+)[:.]\s*)(.*?)(?=(?:\n\s*(?:Step\s*\d+[:.]\s*|\d+[:.]\s*)|$))/gims;
            const steps: string[] = [];
            let match;

            while ((match = stepRegex.exec(plan)) !== null) {
                const stepContent = match[3].trim();
                if (stepContent) {
                    steps.push(stepContent);
                }
            }

            if (steps.length === 0) {
                this.addMessageToChat('assistant', '❌ No actionable steps were found in the plan. Let me try again with a clearer format.');
                return;
            }

            // Show total number of steps
            this.addMessageToChat('assistant', `🚀 Found ${steps.length} steps to execute...`);
            
            for (let i = 0; i < steps.length; i++) {
                const step = steps[i];
                this.addMessageToChat('assistant', `📝 Step ${i + 1}/${steps.length}: ${step}`);

                // Prepare execution instructions for this step
                const executionInstructions = `Original user request: "${text}"

Current step to implement: ${step}

Requirements:
1. FIRST create all necessary files using ### filename.ext markers
2. Include all required code, imports, and dependencies in the files
3. Only after creating files, specify any necessary commands with $ prefix
4. Use TypeScript/JavaScript where possible
5. Add error handling and logging
6. Follow security practices

File Creation Format:
### filename.ext
content
%%%

Workspace context:${contextInfo}`;

                // Get implementation from AI
                const executionCompletion = await this.openai.chat.completions.create({
                    model: 'o3-mini',
                    messages: [
                        { 
                            role: 'system', 
                            content: 'You are a software developer. ALWAYS create necessary files before suggesting any commands. Never suggest commands without creating the required files first.' 
                        },
                        { role: 'user', content: text },
                        { role: 'assistant', content: 'I will help implement this step of your request.' },
                        { role: 'user', content: executionInstructions }
                    ]
                });

                const implementation = executionCompletion.choices[0].message.content || '';
                
                // First check if there are any file markers
                if (!implementation.includes('### ')) {
                    this.addMessageToChat('assistant', '⚠️ No files were specified for creation. Skipping this step as file creation is required.');
                    continue;
                }

                // Process file creation markers
                let filesCreated = false;
                try {
                    await this.processFileCreationMarkers(implementation);
                    filesCreated = true;
                    this.addMessageToChat('assistant', '✅ Files created successfully');
                } catch (error) {
                    this.addMessageToChat('assistant', `❌ Error creating files: ${error instanceof Error ? error.message : 'Unknown error'}`);
                    continue; // Skip to next step if file creation fails
                }

                // Only process commands if files were created successfully
                if (filesCreated) {
                    const commandRegex = /\$ (.*)/g;
                    const commands = [...implementation.matchAll(commandRegex)].map(match => match[1]);
                    
                    if (commands.length > 0) {
                        this.addMessageToChat('assistant', '⚡ Executing commands after successful file creation:');
                        // Execute commands in parallel within the same step
                        const results = await Promise.all(commands.map(async command => {
                            this.addMessageToChat('assistant', `📝 Starting: ${command}`);
                            return {
                                command,
                                success: await this.executeCommandWithRetry(command)
                            };
                        }));

                        // Check if any command failed
                        if (results.some(r => !r.success)) {
                            const failedCommands = results.filter(r => !r.success).map(r => r.command);
                            this.addMessageToChat('assistant', `⚠️ Some commands failed: ${failedCommands.join(', ')}`);
                            continue; // Skip to next step if any command failed
                        }
                    }
                }

                // Show completion for this step
                this.addMessageToChat('assistant', `✅ Completed step ${i + 1}/${steps.length}`);
            }

            // Final completion message
            this.addMessageToChat('assistant', '🎉 All steps have been completed successfully!');
        } catch (error) {
            vscode.window.showErrorMessage(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
            this.addMessageToChat('assistant', '❌ An error occurred while processing your request.');
        }
    }

    private async processFileCreationMarkers(text: string) {
        const fileRegex = /###\s*([^\n]+)\s*\n([\s\S]*?)%%%/g;
        let match;

        while ((match = fileRegex.exec(text)) !== null) {
            const [_, filePath, content] = match;
            // Clean up the content by removing markdown code block markers
            const cleanContent = content
                .trim()
                .replace(/^```[\w-]*\n/gm, '') // Remove opening code block markers
                .replace(/```$/gm, '')         // Remove closing code block markers
                .replace(/^`{1,2}[\w-]*\n/gm, '') // Remove inline code markers
                .replace(/`{1,2}$/gm, '')         // Remove closing inline code markers
                .trim();
            
            await this.createFile(filePath.trim(), cleanContent);
        }
    }

    private async createFile(filePath: string, content: string) {
        try {
            if (!vscode.workspace.workspaceFolders) {
                throw new Error('No workspace folder is open');
            }

            const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
            const fullPath = path.join(workspaceRoot, filePath);

            // Create directory if it doesn't exist
            await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });

            // Write file content
            await fs.promises.writeFile(fullPath, content);

            // Automatically include the new file in context
            await this.contextManager.includeFile(filePath);

            // Show success message
            vscode.window.showInformationMessage(`Created and included file: ${filePath}`);

            // Open the file in editor
            const document = await vscode.workspace.openTextDocument(fullPath);
            await vscode.window.showTextDocument(document);

            // Update the file tree view to show the new file with blue dot
            if (this.fileViewProvider) {
                await this.fileViewProvider.updateFileList();
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to create file ${filePath}: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    private addMessageToChat(role: 'user' | 'assistant', content: string) {
        if (this._view) {
            this._view.webview.postMessage({
                type: 'addMessage',
                html: `
                    <div class="message ${role}-message">
                        <div class="message-content">${this.escapeHtml(content)}</div>
                    </div>
                `
            });
        }
    }

    private escapeHtml(unsafe: string): string {
        return unsafe
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    private _getHtmlForWebview() {
        return `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Falalo AI Chat</title>
                <style>
                    :root {
                        --card-bg: var(--vscode-editor-background);
                        --card-border: var(--vscode-panel-border);
                        --accent-color: #0098ff;
                        --accent-color-light: #0098ff33;
                        --warning-color: #ff8c00;
                        --warning-color-light: #ff8c0033;
                        --success-color: #28a745;
                        --error-color: #dc3545;
                    }

                    body {
                        padding: 16px;
                        color: var(--vscode-editor-foreground);
                        background-color: var(--vscode-editor-background);
                        display: flex;
                        flex-direction: column;
                        height: 100vh;
                        margin: 0;
                        font-family: var(--vscode-font-family);
                        line-height: 1.5;
                    }

                    .chat-container {
                        display: flex;
                        flex-direction: column;
                        height: 100%;
                        gap: 16px;
                    }

                    .messages {
                        flex-grow: 1;
                        overflow-y: auto;
                        margin-bottom: 10px;
                        padding-right: 8px;
                        scroll-behavior: smooth;
                    }

                    .message {
                        margin: 12px 0;
                        max-width: 85%;
                        word-wrap: break-word;
                        animation: fadeIn 0.3s ease-in-out;
                    }

                    @keyframes fadeIn {
                        from { opacity: 0; transform: translateY(10px); }
                        to { opacity: 1; transform: translateY(0); }
                    }

                    .message-content {
                        padding: 12px 16px;
                        border-radius: 12px;
                        box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
                        position: relative;
                    }

                    .user-message {
                        margin-left: auto;
                    }

                    .user-message .message-content {
                        background-color: var(--accent-color);
                        color: white;
                        border-radius: 12px 12px 2px 12px;
                    }

                    .assistant-message {
                        margin-right: auto;
                    }

                    .assistant-message .message-content {
                        background-color: var(--vscode-editor-inactiveSelectionBackground);
                        border-radius: 12px 12px 12px 2px;
                        border: 1px solid var(--card-border);
                    }

                    .input-container {
                        background: var(--card-bg);
                        border: 1px solid var(--card-border);
                        border-radius: 12px;
                        padding: 16px;
                        gap: 12px;
                        display: flex;
                        flex-direction: column;
                        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
                    }

                    .help-toggle {
                        font-size: 12px;
                        color: var(--accent-color);
                        cursor: pointer;
                        text-decoration: none;
                        display: inline-flex;
                        align-items: center;
                        gap: 4px;
                        transition: all 0.2s ease;
                    }

                    .help-toggle:hover {
                        color: var(--accent-color-light);
                    }

                    .help-toggle::before {
                        content: '💡';
                        font-size: 14px;
                    }

                    .file-format-help {
                        background: var(--card-bg);
                        border: 1px solid var(--card-border);
                        border-radius: 8px;
                        padding: 16px;
                        font-size: 13px;
                        margin-bottom: 12px;
                        box-shadow: 0 2px 4px rgba(0, 0, 0, 0.05);
                    }

                    .file-format-help pre {
                        background: var(--vscode-editor-background);
                        border: 1px solid var(--card-border);
                        border-radius: 6px;
                        padding: 12px;
                        font-size: 12px;
                        margin: 8px 0;
                        overflow-x: auto;
                    }

                    .input-row {
                        display: flex;
                        gap: 12px;
                        align-items: flex-end;
                    }

                    textarea {
                        flex-grow: 1;
                        padding: 12px;
                        border: 1px solid var(--vscode-input-border);
                        background: var(--vscode-input-background);
                        color: var(--vscode-input-foreground);
                        border-radius: 8px;
                        resize: vertical;
                        min-height: 60px;
                        max-height: 200px;
                        font-family: var(--vscode-editor-font-family);
                        font-size: var(--vscode-editor-font-size);
                        line-height: 1.5;
                        transition: border-color 0.2s ease;
                    }

                    textarea:focus {
                        outline: none;
                        border-color: var(--accent-color);
                    }

                    button {
                        padding: 10px 20px;
                        background: var(--accent-color);
                        color: white;
                        border: none;
                        border-radius: 8px;
                        cursor: pointer;
                        font-weight: 500;
                        transition: all 0.2s ease;
                        display: inline-flex;
                        align-items: center;
                        gap: 6px;
                    }

                    button::after {
                        content: '↗️';
                        font-size: 14px;
                    }

                    button:hover {
                        background: var(--accent-color-light);
                        transform: translateY(-1px);
                    }

                    .status-indicator {
                        display: inline-flex;
                        align-items: center;
                        gap: 4px;
                        font-size: 12px;
                        padding: 4px 8px;
                        border-radius: 12px;
                        margin-bottom: 4px;
                    }

                    .status-indicator.planning {
                        background: var(--accent-color-light);
                        color: var(--accent-color);
                    }

                    .status-indicator.executing {
                        background: var(--warning-color-light);
                        color: var(--warning-color);
                    }

                    .status-indicator.success {
                        background: var(--success-color);
                        color: white;
                    }

                    .status-indicator.error {
                        background: var(--error-color);
                        color: white;
                    }

                    pre {
                        white-space: pre-wrap;
                        word-wrap: break-word;
                    }

                    code {
                        font-family: var(--vscode-editor-font-family);
                        font-size: var(--vscode-editor-font-size);
                        background: var(--vscode-editor-background);
                        padding: 2px 4px;
                        border-radius: 4px;
                    }
                </style>
            </head>
            <body>
                <div class="chat-container">
                    <div class="messages" id="messages"></div>
                    <div class="input-container">
                        <div class="help-toggle" id="helpToggle">Show file creation format help</div>
                        <div class="file-format-help" id="fileFormatHelp" style="display: none;">
                            <strong>File Creation Format</strong>
                            <p>To create files, use this exact format:</p>
                            <pre>### filename.ext
EXACT file content here (no markdown formatting)
%%%</pre>
                            <p>Example:</p>
                            <pre>### src/hello.py
def main():
    print("Hello, World!")
    
if __name__ == "__main__":
    main()
%%%</pre>
                            <p>For multiple files:</p>
                            <pre>### file1.js
const greeting = "Hello";
console.log(greeting);
%%%

### file2.css
.button {
    color: blue;
    padding: 10px;
}
%%%</pre>
                            <p><strong>Important:</strong> Do not add any markdown formatting around the file content. The content between ### and %%% will be written to the file exactly as is.</p>
                        </div>
                        <div class="input-row">
                            <textarea id="userInput" placeholder="Type your message... Use ### filename.ext to start a file and %%% to end it"></textarea>
                        </div>
                        <button id="sendButton">Send</button>
                    </div>
                </div>
                <script>
                    const vscode = acquireVsCodeApi();
                    const messagesDiv = document.getElementById('messages');
                    const userInput = document.getElementById('userInput');
                    const sendButton = document.getElementById('sendButton');
                    const helpToggle = document.getElementById('helpToggle');
                    const fileFormatHelp = document.getElementById('fileFormatHelp');

                    helpToggle.addEventListener('click', () => {
                        const isHidden = fileFormatHelp.style.display === 'none';
                        fileFormatHelp.style.display = isHidden ? 'block' : 'none';
                        helpToggle.textContent = isHidden ? 'Hide file creation format help' : 'Show file creation format help';
                    });

                    sendButton.addEventListener('click', () => {
                        const message = userInput.value.trim();
                        if (message) {
                            vscode.postMessage({ type: 'message', text: message });
                            userInput.value = '';
                        }
                    });

                    userInput.addEventListener('keydown', (e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            sendButton.click();
                        }
                    });

                    window.addEventListener('message', event => {
                        const message = event.data;
                        switch (message.type) {
                            case 'addMessage':
                                const messageDiv = document.createElement('div');
                                messageDiv.innerHTML = message.html;
                                messagesDiv.appendChild(messageDiv);
                                messagesDiv.scrollTop = messagesDiv.scrollHeight;
                                break;
                        }
                    });
                </script>
            </body>
            </html>
        `;
    }

    // Add cleanup method for terminals
    private cleanupTerminals() {
        for (const [id, terminal] of this.activeTerminals) {
            terminal.dispose();
        }
        this.activeTerminals.clear();
    }

    // Update deactivate to clean up terminals
    public deactivate() {
        this.cleanupTerminals();
    }
}

class FileViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'falaloFiles';
    private _view?: vscode.WebviewView;
    private contextManager: ContextManager;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _extensionContext: vscode.ExtensionContext,
        contextManager: ContextManager
    ) {
        this.contextManager = contextManager;
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                this._extensionUri
            ]
        };

        webviewView.webview.html = this._getHtmlForWebview();
        
        // Initial file list update
        this.updateFileList();

        // Set up file system watcher
        const watcher = vscode.workspace.createFileSystemWatcher('**/*');
        watcher.onDidCreate(() => this.updateFileList());
        watcher.onDidDelete(() => this.updateFileList());
        watcher.onDidChange(() => this.updateFileList());

        // Handle messages from the webview
        webviewView.webview.onDidReceiveMessage(async message => {
            switch (message.type) {
                case 'openFile':
                    try {
                        // Ensure the file path is within the workspace
                        if (!vscode.workspace.workspaceFolders) {
                            throw new Error('No workspace folder is open');
                        }
                        const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
                        const fullPath = path.join(workspaceRoot, message.path);
                        
                        // Check if file exists before trying to open it
                        if (!fs.existsSync(fullPath)) {
                            throw new Error(`File does not exist: ${message.path}`);
                        }
                        
                        // Create VS Code URI for the file
                        const fileUri = vscode.Uri.file(fullPath);
                        
                        // Try to open the document
                        const document = await vscode.workspace.openTextDocument(fileUri);
                        await vscode.window.showTextDocument(document);
                    } catch (error) {
                        vscode.window.showErrorMessage(`Failed to open file: ${error instanceof Error ? error.message : 'Unknown error'}`);
                    }
                    break;
                case 'toggleFileContext':
                    try {
                        if (message.isIncluded) {
                            await this.contextManager.includeFile(message.path);
                            vscode.window.showInformationMessage(`Added ${message.path} to context`);
                        } else if (message.isExcluded) {
                            this.contextManager.excludeFile(message.path);
                            vscode.window.showInformationMessage(`Excluded ${message.path} from context`);
                        } else {
                            this.contextManager.excludeFile(message.path);
                            vscode.window.showInformationMessage(`Removed ${message.path} from context`);
                        }
                        this.updateFileList();
                    } catch (error) {
                        vscode.window.showErrorMessage((error as Error).message);
                    }
                    break;
                case 'toggleDirectoryContext':
                    try {
                        const files = message.files;
                        if (message.isIncluded) {
                            for (const file of files) {
                                await this.contextManager.includeFile(file);
                            }
                            vscode.window.showInformationMessage(`Added directory contents to context`);
                        } else if (message.isExcluded) {
                            for (const file of files) {
                                this.contextManager.excludeFile(file);
                            }
                            vscode.window.showInformationMessage(`Excluded directory contents from context`);
                        } else {
                            for (const file of files) {
                                this.contextManager.excludeFile(file);
                            }
                            vscode.window.showInformationMessage(`Removed directory contents from context`);
                        }
                        this.updateFileList();
                    } catch (error) {
                        vscode.window.showErrorMessage((error as Error).message);
                    }
                    break;
            }
        });
    }

    public async updateFileList() {
        if (!this._view || !vscode.workspace.workspaceFolders) {
            return;
        }

        const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
        const files = await glob.glob('**/*', { 
            cwd: workspaceRoot,
            nodir: true,
            ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**']
        });

        // Sort files by path
        files.sort();

        // Get included files from context manager
        const includedFiles = this.contextManager.getIncludedFiles();
        const excludedFiles = this.contextManager.getExcludedFiles();

        // Build file tree with status
        const fileTree = this.buildFileTree(files, includedFiles, excludedFiles);

        this._view.webview.postMessage({
            type: 'updateFiles',
            files: fileTree
        });
    }

    private buildFileTree(files: string[], includedFiles: string[], excludedFiles: string[]) {
        const tree: any = {};
        
        for (const file of files) {
            const parts = file.split('/');
            let current = tree;
            let currentPath = '';
            
            for (let i = 0; i < parts.length; i++) {
                const part = parts[i];
                currentPath = currentPath ? `${currentPath}/${part}` : part;
                
                if (i === parts.length - 1) {
                    // It's a file
                    if (!current.files) {
                        current.files = [];
                    }
                    current.files.push({
                        name: part,
                        path: currentPath,
                        isIncluded: includedFiles.includes(currentPath),
                        isExcluded: excludedFiles.includes(currentPath)
                    });
                } else {
                    // It's a directory
                    if (!current.dirs) {
                        current.dirs = {};
                    }
                    if (!current.dirs[part]) {
                        current.dirs[part] = {
                            path: currentPath
                        };
                    }
                    current = current.dirs[part];
                }
            }
        }
        
        return tree;
    }

    private _getHtmlForWebview() {
        return `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Project Files</title>
                <style>
                    :root {
                        --card-bg: var(--vscode-editor-background);
                        --card-border: var(--vscode-panel-border);
                        --accent-color: #0098ff;
                        --accent-color-light: #0098ff33;
                        --warning-color: #ff8c00;
                        --warning-color-light: #ff8c0033;
                    }

                    body {
                        padding: 16px;
                        color: var(--vscode-editor-foreground);
                        background-color: var(--vscode-editor-background);
                        font-family: var(--vscode-font-family);
                        line-height: 1.5;
                    }

                    .file-tree {
                        user-select: none;
                        animation: fadeIn 0.3s ease-in-out;
                    }

                    @keyframes fadeIn {
                        from { opacity: 0; transform: translateY(10px); }
                        to { opacity: 1; transform: translateY(0); }
                    }

                    .directory {
                        margin-left: 24px;
                        border-left: 1px solid var(--card-border);
                        padding-left: 4px;
                    }

                    .directory-name {
                        cursor: pointer;
                        padding: 8px 12px;
                        border-radius: 6px;
                        display: flex;
                        align-items: center;
                        transition: all 0.2s ease;
                        margin: 4px 0;
                    }

                    .directory-name:hover {
                        background-color: var(--vscode-list-hoverBackground);
                    }

                    .file {
                        margin-left: 24px;
                        cursor: pointer;
                        padding: 6px 12px;
                        border-radius: 6px;
                        display: flex;
                        align-items: center;
                        transition: all 0.2s ease;
                        margin: 4px 0;
                    }

                    .file:hover {
                        background-color: var(--vscode-list-hoverBackground);
                        transform: translateX(2px);
                    }

                    .collapsed {
                        display: none;
                    }

                    .icon {
                        margin-right: 8px;
                        font-size: 16px;
                        width: 20px;
                        text-align: center;
                    }

                    .included {
                        color: var(--accent-color);
                    }

                    .excluded {
                        color: var(--warning-color);
                    }

                    .context-indicator {
                        width: 8px;
                        height: 8px;
                        border-radius: 50%;
                        margin-left: 8px;
                        transition: all 0.2s ease;
                    }

                    .context-indicator.included {
                        background-color: var(--accent-color);
                        box-shadow: 0 0 4px var(--accent-color);
                    }

                    .context-indicator.excluded {
                        background-color: var(--warning-color);
                        box-shadow: 0 0 4px var(--warning-color);
                    }

                    .actions {
                        margin-left: auto;
                        display: flex;
                        gap: 8px;
                        opacity: 0;
                        transition: opacity 0.2s ease;
                    }

                    .file:hover .actions,
                    .directory-name:hover .actions {
                        opacity: 1;
                    }

                    .action-button {
                        padding: 4px 8px;
                        border-radius: 4px;
                        font-size: 11px;
                        cursor: pointer;
                        transition: all 0.2s ease;
                        display: flex;
                        align-items: center;
                        gap: 4px;
                    }

                    .include-button {
                        background-color: var(--accent-color-light);
                        color: var(--accent-color);
                    }

                    .include-button:hover {
                        background-color: var(--accent-color);
                        color: white;
                    }

                    .exclude-button {
                        background-color: var(--warning-color-light);
                        color: var(--warning-color);
                    }

                    .exclude-button:hover {
                        background-color: var(--warning-color);
                        color: white;
                    }

                    .file.selected {
                        background-color: var(--vscode-list-activeSelectionBackground);
                        color: var(--vscode-list-activeSelectionForeground);
                        box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
                        transform: translateX(4px);
                    }

                    .file.selected .context-indicator.included {
                        background-color: var(--vscode-list-activeSelectionForeground);
                        box-shadow: none;
                    }

                    .file.selected .context-indicator.excluded {
                        background-color: var(--vscode-list-activeSelectionForeground);
                        opacity: 0.7;
                        box-shadow: none;
                    }

                    .file.selected .action-button {
                        background-color: var(--vscode-list-activeSelectionBackground);
                        color: var(--vscode-list-activeSelectionForeground);
                        border: 1px solid var(--vscode-list-activeSelectionForeground);
                    }

                    .file.selected .action-button:hover {
                        background-color: var(--vscode-list-activeSelectionForeground);
                        color: var(--vscode-list-activeSelectionBackground);
                    }
                </style>
            </head>
            <body>
                <div id="file-tree" class="file-tree"></div>
                <script>
                    const vscode = acquireVsCodeApi();
                    const fileTree = document.getElementById('file-tree');

                    function getAllFilesInDirectory(dirContent) {
                        let files = [];
                        if (dirContent.files) {
                            files.push(...dirContent.files.map(f => f.path));
                        }
                        if (dirContent.dirs) {
                            for (const [_, content] of Object.entries(dirContent.dirs)) {
                                files.push(...getAllFilesInDirectory(content));
                            }
                        }
                        return files;
                    }

                    function createFileTree(tree, parentElement, path = '') {
                        // Handle directories
                        if (tree.dirs) {
                            for (const [dirName, content] of Object.entries(tree.dirs)) {
                                const dirDiv = document.createElement('div');
                                const dirNameDiv = document.createElement('div');
                                const contentDiv = document.createElement('div');
                                
                                dirNameDiv.className = 'directory-name';
                                dirNameDiv.innerHTML = '<span class="icon">📁</span>' + dirName;
                                
                                // Add action buttons for directory
                                const actionsDiv = document.createElement('div');
                                actionsDiv.className = 'actions';
                                
                                const includeButton = document.createElement('span');
                                includeButton.className = 'action-button include-button';
                                includeButton.textContent = 'Include';
                                includeButton.onclick = (e) => {
                                    e.stopPropagation();
                                    const files = getAllFilesInDirectory(content);
                                    vscode.postMessage({
                                        type: 'toggleDirectoryContext',
                                        files: files,
                                        isIncluded: true,
                                        isExcluded: false
                                    });
                                };
                                
                                const excludeButton = document.createElement('span');
                                excludeButton.className = 'action-button exclude-button';
                                excludeButton.textContent = 'Exclude';
                                excludeButton.onclick = (e) => {
                                    e.stopPropagation();
                                    const files = getAllFilesInDirectory(content);
                                    vscode.postMessage({
                                        type: 'toggleDirectoryContext',
                                        files: files,
                                        isIncluded: false,
                                        isExcluded: true
                                    });
                                };
                                
                                actionsDiv.appendChild(includeButton);
                                actionsDiv.appendChild(excludeButton);
                                dirNameDiv.appendChild(actionsDiv);
                                
                                contentDiv.className = 'directory';
                                
                                dirDiv.appendChild(dirNameDiv);
                                dirDiv.appendChild(contentDiv);
                                parentElement.appendChild(dirDiv);

                                dirNameDiv.addEventListener('click', () => {
                                    contentDiv.classList.toggle('collapsed');
                                    dirNameDiv.querySelector('.icon').textContent = 
                                        contentDiv.classList.contains('collapsed') ? '📁' : '📂';
                                });

                                createFileTree(content, contentDiv, content.path);
                            }
                        }

                        // Handle files
                        if (tree.files) {
                            for (const file of tree.files) {
                                const fileDiv = document.createElement('div');
                                fileDiv.className = 'file';
                                if (file.isIncluded) fileDiv.classList.add('included');
                                if (file.isExcluded) fileDiv.classList.add('excluded');
                                
                                const icon = document.createElement('span');
                                icon.className = 'icon';
                                icon.textContent = '📄';
                                
                                const fileName = document.createElement('span');
                                fileName.textContent = file.name;
                                
                                const indicator = document.createElement('span');
                                indicator.className = 'context-indicator';
                                if (file.isIncluded) indicator.classList.add('included');
                                if (file.isExcluded) indicator.classList.add('excluded');
                                
                                const actionsDiv = document.createElement('div');
                                actionsDiv.className = 'actions';
                                
                                const includeButton = document.createElement('span');
                                includeButton.className = 'action-button include-button';
                                includeButton.textContent = 'Include';
                                includeButton.onclick = (e) => {
                                    e.stopPropagation();
                                    vscode.postMessage({
                                        type: 'toggleFileContext',
                                        path: file.path,
                                        isIncluded: true,
                                        isExcluded: false
                                    });
                                };
                                
                                const excludeButton = document.createElement('span');
                                excludeButton.className = 'action-button exclude-button';
                                excludeButton.textContent = 'Exclude';
                                excludeButton.onclick = (e) => {
                                    e.stopPropagation();
                                    vscode.postMessage({
                                        type: 'toggleFileContext',
                                        path: file.path,
                                        isIncluded: false,
                                        isExcluded: true
                                    });
                                };
                                
                                actionsDiv.appendChild(includeButton);
                                actionsDiv.appendChild(excludeButton);
                                
                                fileDiv.appendChild(icon);
                                fileDiv.appendChild(fileName);
                                fileDiv.appendChild(indicator);
                                fileDiv.appendChild(actionsDiv);
                                
                                // Change single click to just select the file
                                fileDiv.addEventListener('click', () => {
                                    // Remove selected class from all files
                                    document.querySelectorAll('.file').forEach(f => f.classList.remove('selected'));
                                    // Add selected class to this file
                                    fileDiv.classList.add('selected');
                                });

                                // Add double click to open file
                                fileDiv.addEventListener('dblclick', () => {
                                    vscode.postMessage({
                                        type: 'openFile',
                                        path: file.path
                                    });
                                });
                                
                                parentElement.appendChild(fileDiv);
                            }
                        }
                    }

                    window.addEventListener('message', event => {
                        const message = event.data;
                        switch (message.type) {
                            case 'updateFiles':
                                fileTree.innerHTML = '';
                                createFileTree(message.files, fileTree);
                                break;
                        }
                    });
                </script>
            </body>
            </html>
        `;
    }
}

export function activate(context: vscode.ExtensionContext) {
    const contextManager = new ContextManager();
    const chatViewProvider = new ChatViewProvider(context.extensionUri, context, contextManager);
    const fileViewProvider = new FileViewProvider(context.extensionUri, context, contextManager);

    // Set up the connection between providers
    chatViewProvider.setFileViewProvider(fileViewProvider);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chatViewProvider),
        vscode.window.registerWebviewViewProvider(FileViewProvider.viewType, fileViewProvider)
    );

    let disposables: vscode.Disposable[] = [];

    disposables.push(
        vscode.commands.registerCommand('falalo.includeInContext', async () => {
            const files = await vscode.window.showOpenDialog({
                canSelectMany: true,
                openLabel: 'Include in Context'
            });
            
            if (files) {
                for (const file of files) {
                    try {
                        await contextManager.includeFile(file.fsPath);
                        vscode.window.showInformationMessage(`Added ${file.fsPath} to context`);
                    } catch (error) {
                        vscode.window.showErrorMessage((error as Error).message);
                    }
                }
            }
        })
    );

    disposables.push(
        vscode.commands.registerCommand('falalo.excludeFromContext', async () => {
            const files = contextManager.getIncludedFiles();
            const selected = await vscode.window.showQuickPick(files, {
                canPickMany: true,
                placeHolder: 'Select files to exclude from context'
            });

            if (selected) {
                selected.forEach((file: string) => {
                    contextManager.excludeFile(file);
                    vscode.window.showInformationMessage(`Removed ${file} from context`);
                });
            }
        })
    );

    disposables.push(
        vscode.commands.registerCommand('falalo.showContextItems', () => {
            const files = contextManager.getIncludedFiles();
            const panel = vscode.window.createWebviewPanel(
                'contextFiles',
                'Context Files',
                vscode.ViewColumn.Two,
                {}
            );

            panel.webview.html = `
                <!DOCTYPE html>
                <html>
                <head>
                    <style>
                        body { padding: 20px; }
                        .file-list { font-family: monospace; }
                    </style>
                </head>
                <body>
                    <h2>Files in Context (${files.length})</h2>
                    <div class="file-list">
                        ${files.map(f => `<div>${f}</div>`).join('')}
                    </div>
                </body>
                </html>
            `;
        })
    );

    context.subscriptions.push(...disposables);
}

export function deactivate() {} 