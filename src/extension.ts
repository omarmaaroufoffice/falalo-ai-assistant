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
    private tokenCount: { input: number, output: number } = { input: 0, output: 0 };
    private tokenCountPanel?: vscode.WebviewPanel;

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

        // Load saved token counts from extension context
        const savedTokenCount = this._extensionContext.globalState.get('tokenCount') as { input: number, output: number } | undefined;
        if (savedTokenCount && typeof savedTokenCount.input === 'number' && typeof savedTokenCount.output === 'number') {
            this.tokenCount = savedTokenCount;
        }
        
        this.createTokenCountPanel();
    }

    private createTokenCountPanel() {
        this.tokenCountPanel = vscode.window.createWebviewPanel(
            'tokenCounter',
            'Token Counter',
            { viewColumn: vscode.ViewColumn.Three, preserveFocus: true },
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        // Add reset button to panel
        this.updateTokenCountPanel();

        // Handle messages from the webview
        this.tokenCountPanel.webview.onDidReceiveMessage(async message => {
            if (message.command === 'resetTokens') {
                await this.resetTokenCount();
            }
        });
    }

    private updateTokenCountPanel() {
        if (this.tokenCountPanel) {
            this.tokenCountPanel.webview.html = `
                <!DOCTYPE html>
                <html>
                <head>
                    <style>
                        body {
                            padding: 20px;
                            font-family: var(--vscode-font-family);
                            color: var(--vscode-editor-foreground);
                        }
                        .counter {
                            display: flex;
                            flex-direction: column;
                            gap: 10px;
                        }
                        .count-item {
                            display: flex;
                            justify-content: space-between;
                            padding: 10px;
                            background: var(--vscode-editor-background);
                            border: 1px solid var(--vscode-panel-border);
                            border-radius: 4px;
                        }
                        .total {
                            margin-top: 10px;
                            padding-top: 10px;
                            border-top: 1px solid var(--vscode-panel-border);
                            font-weight: bold;
                        }
                        .reset-button {
                            margin-top: 20px;
                            padding: 8px 16px;
                            background: var(--vscode-button-background);
                            color: var(--vscode-button-foreground);
                            border: none;
                            border-radius: 4px;
                            cursor: pointer;
                        }
                        .reset-button:hover {
                            background: var(--vscode-button-hoverBackground);
                        }
                    </style>
                </head>
                <body>
                    <div class="counter">
                        <div class="count-item">
                            <span>Total Input Tokens:</span>
                            <strong>${this.tokenCount.input.toLocaleString()}</strong>
                        </div>
                        <div class="count-item">
                            <span>Total Output Tokens:</span>
                            <strong>${this.tokenCount.output.toLocaleString()}</strong>
                        </div>
                        <div class="count-item total">
                            <span>Total Tokens:</span>
                            <strong>${(this.tokenCount.input + this.tokenCount.output).toLocaleString()}</strong>
                        </div>
                    </div>
                    <button class="reset-button" onclick="resetTokens()">Reset Token Count</button>
                    <script>
                        const vscode = acquireVsCodeApi();
                        function resetTokens() {
                            vscode.postMessage({ command: 'resetTokens' });
                        }
                    </script>
                </body>
                </html>
            `;
        }
    }

    private async updateTokenCount(completion: any) {
        if (completion?.usage) {
            // Add new tokens to existing counts
            this.tokenCount.input += completion.usage.prompt_tokens || 0;
            this.tokenCount.output += completion.usage.completion_tokens || 0;
            
            // Save updated counts to extension context
            await this._extensionContext.globalState.update('tokenCount', this.tokenCount);
            
            this.updateTokenCountPanel();
        }
    }

    // Add cleanup method for token counts
    private async resetTokenCount() {
        this.tokenCount = { input: 0, output: 0 };
        await this._extensionContext.globalState.update('tokenCount', this.tokenCount);
        this.updateTokenCountPanel();
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
                let outputBuffer = '';
                let errorBuffer = '';

                // Create write streams for output and error logging
                const outputPath = `/tmp/${terminalId}_output`;
                const errorPath = `/tmp/${terminalId}_error`;
                const exitCodePath = `/tmp/${terminalId}_exit_code`;

                const terminal = vscode.window.createTerminal({
                    name: terminalId,
                    shellPath: process.platform === 'win32' ? 'cmd.exe' : '/bin/bash'
                });

                this.activeTerminals.set(terminalId, terminal);

                // Detect if this is a long-running command (like npm run dev)
                const isLongRunningCommand = command.match(/(npm run (dev|start|serve)|ng serve|python manage\.py runserver|rails s|yarn (start|dev)|docker-compose up)/i);

                // For long-running commands, we don't wait for completion
                if (isLongRunningCommand) {
                    this.addMessageToChat('assistant', `🚀 Starting long-running command in terminal ${terminalId}:\n${command}`);
                    terminal.show(true);
                    terminal.sendText(command);
                    resolve(true);
                    return;
                }

                // For regular commands, we monitor execution and handle errors
                const disposable = vscode.window.onDidCloseTerminal(async closedTerminal => {
                    if (closedTerminal === terminal) {
                        disposable.dispose();
                        this.activeTerminals.delete(terminalId);
                        try {
                            // Read all captured output
                            const fs = require('fs');
                            const [output, errors, exitCodeStr] = await Promise.all([
                                fs.promises.readFile(outputPath, 'utf8').catch(() => ''),
                                fs.promises.readFile(errorPath, 'utf8').catch(() => ''),
                                fs.promises.readFile(exitCodePath, 'utf8').catch(() => '1')
                            ]);

                            const actualExitCode = parseInt(exitCodeStr.trim(), 10);
                            
                            // Combine output and errors for context
                            const fullOutput = `OUTPUT:\n${output}\n\nERRORS:\n${errors}`;
                            this.terminalOutput = `${this.terminalOutput}\n$ ${command} (Terminal: ${terminalId})\n${fullOutput}\nExit code: ${actualExitCode}\n`;

                            if (actualExitCode !== 0) {
                                this.addMessageToChat('assistant', `⚠️ Command failed with exit code ${actualExitCode}. Output:\n${fullOutput}`);
                                
                                if (retryCount < this.maxRetries - 1) {
                                    // Get AI suggestion before retrying - only pass error message
                                    const recovered = await this.handleCommandFailure(command, errors, output);
                                    if (recovered) {
                                        resolve(true);
                                        return;
                                    }

                                    this.addMessageToChat('assistant', `Retrying (attempt ${retryCount + 2}/${this.maxRetries})...`);
                                    await new Promise(resolve => setTimeout(resolve, 2000));
                                    const success = await this.executeCommandWithRetry(command, retryCount + 1);
                                    resolve(success);
                                } else {
                                    this.addMessageToChat('assistant', `❌ Command failed after ${this.maxRetries} attempts. Full output:\n${fullOutput}`);
                                    resolve(false);
                                }
                            } else {
                                this.addMessageToChat('assistant', `✅ Command executed successfully in terminal ${terminalId}\nOutput:\n${fullOutput}`);
                                resolve(true);
                            }

                            // Cleanup temp files
                            await Promise.all([
                                fs.promises.unlink(outputPath).catch(() => {}),
                                fs.promises.unlink(errorPath).catch(() => {}),
                                fs.promises.unlink(exitCodePath).catch(() => {})
                            ]);

                        } catch (error) {
                            this.addMessageToChat('assistant', `⚠️ Error processing command output: ${error}`);
                            resolve(false);
                        }
                    }
                });

                terminal.show(true);
                
                // Wrap command to capture both stdout and stderr separately and ensure proper completion
                const wrappedCommand = process.platform === 'win32' 
                    ? `${command} > "${outputPath}" 2> "${errorPath}" & echo %ERRORLEVEL% > "${exitCodePath}" & exit`
                    : `${command} > "${outputPath}" 2> "${errorPath}"; echo $? > "${exitCodePath}"; exit`;
                
                this.addMessageToChat('assistant', `🚀 Executing command in terminal ${terminalId}:\n${command}`);
                terminal.sendText(wrappedCommand);
            });
        } catch (error) {
            this.addMessageToChat('assistant', `⚠️ Error executing command: ${error}`);
            return false;
        }
    }

    private async handleUserMessage(text: string) {
        try {
            if (!this._view) {
                return;
            }

            // Add step timeout constant
            const STEP_TIMEOUT_MS = 60000; // 1 minute

            this.addMessageToChat('user', text);

            const includedFiles = this.contextManager.getIncludedFiles();
            const excludedFiles = this.contextManager.getExcludedFiles();

            let contextInfo = '';
            if (includedFiles.length > 0) {
                contextInfo += '\nIncluded files in context:\n' + includedFiles.join('\n');
            }
            if (excludedFiles.length > 0) {
                contextInfo += '\nExcluded files from context:\n' + excludedFiles.join('\n');
            }
            
            // Always include recent terminal output in context
            if (this.terminalOutput) {
                contextInfo += '\nRecent terminal activity:\n' + this.terminalOutput;
            }

            // Stage 1: Planning Phase
            const planningInstructions = `User request: "${text}"

<CURRENT_CURSOR_POSITION>
Create a clear, step-by-step implementation plan.
IMPORTANT: 
1. Number each step clearly as "Step 1:", "Step 2:", etc.
2. Mark steps that contain long-running commands with [LONG-RUNNING] prefix
3. Group related commands together in the same step

Workspace context:${contextInfo}

Focus on:
1-Creating the actual files and code
2-Making it look good
3-Making it extensive and detailed
4-Making sure all the pathways are correct
5-Properly handling errors and output from commands`;

            // Get plan from AI
            const planCompletion = await this.openai.chat.completions.create({
                model: 'o3-mini',
                messages: [
                    { 
                        role: 'system', 
                        content: 'You are a software development planner. Number each step clearly as "Step 1:", "Step 2:", etc. Mark steps with long-running commands using [LONG-RUNNING] prefix.' 
                    },
                    { role: 'user', content: text },
                    { role: 'assistant', content: 'I will help you with that. Let me create a clear, numbered plan.' },
                    { role: 'user', content: planningInstructions }
                ],
            });

            // Update token count
            await this.updateTokenCount(planCompletion);

            const plan = planCompletion.choices[0].message.content || '';
            
            // Show the plan to the user
            this.addMessageToChat('assistant', '🔍 Planning Phase:\n\n' + plan);

            // Stage 2: Execution Phase
            // Extract steps using a more flexible pattern that includes [LONG-RUNNING] prefix
            const stepRegex = /(?:Step\s*(\d+)[:.]\s*(?:\[LONG-RUNNING\]\s*)?|^(\d+)[:.]\s*(?:\[LONG-RUNNING\]\s*)?)(.*?)(?=(?:\n\s*(?:Step\s*\d+[:.]\s*|\d+[:.]\s*)|$))/gims;
            const steps: Array<{content: string, isLongRunning: boolean}> = [];
            let match;

            while ((match = stepRegex.exec(plan)) !== null) {
                const stepContent = match[3].trim();
                const isLongRunning = match[0].includes('[LONG-RUNNING]');
                if (stepContent) {
                    steps.push({ content: stepContent, isLongRunning });
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
                this.addMessageToChat('assistant', `📝 Step ${i + 1}/${steps.length}${step.isLongRunning ? ' [LONG-RUNNING]' : ''}: ${step.content}`);

                // Create a promise that rejects after timeout
                const timeoutPromise = new Promise((_, reject) => {
                    setTimeout(() => reject(new Error('Step timeout')), STEP_TIMEOUT_MS);
                });

                try {
                    // Race between step execution and timeout
                    await Promise.race([
                        this.executeStep(step, text, contextInfo, i),
                        timeoutPromise
                    ]);
                } catch (error: unknown) {
                    if (error instanceof Error && error.message === 'Step timeout') {
                        this.addMessageToChat('assistant', `⚠️ Step ${i + 1} took too long (>1 minute). Moving to next step...`);
                    } else {
                        this.addMessageToChat('assistant', `❌ Error in step ${i + 1}: ${error instanceof Error ? error.message : 'Unknown error'}`);
                    }
                    // Continue to next step regardless of error
                    continue;
                }

                // Add a small delay between steps for better visibility
                if (i < steps.length - 1) {
                    this.addMessageToChat('assistant', `⏳ Transitioning to step ${i + 2}...`);
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }

            // Final completion message
            this.addMessageToChat('assistant', '🎉 All steps have been completed!');
        } catch (error) {
            vscode.window.showErrorMessage(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
            this.addMessageToChat('assistant', '❌ An error occurred while processing your request.');
        }
    }

    private async executeStep(step: {content: string, isLongRunning: boolean}, text: string, contextInfo: string, stepIndex: number): Promise<void> {
        // Prepare execution instructions for this step WITH full context
        const executionInstructions = `Original user request: "${text}"

Current step to implement: ${step.content}
Step type: ${step.isLongRunning ? 'LONG-RUNNING' : 'REGULAR'}

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

        // Get implementation from AI with full context
        const executionCompletion = await this.openai.chat.completions.create({
            model: 'o3-mini',
            messages: [
                { 
                    role: 'system', 
                    content: 'You are a software developer. Create ONE file at a time and execute ONE command at a time. Always wait for each operation to complete before starting the next.' 
                },
                { role: 'user', content: text },
                { role: 'assistant', content: 'I will help implement this step of your request.' },
                { role: 'user', content: executionInstructions }
            ]
        });

        // Update token count
        await this.updateTokenCount(executionCompletion);

        const implementation = executionCompletion.choices[0].message.content || '';
        
        // Extract all file creation markers and commands
        const fileRegex = /###\s*([^\n]+)\s*\n([\s\S]*?)%%%/g;
        const commandRegex = /\$ (.*)/g;
        
        const files = [...implementation.matchAll(fileRegex)].map(match => ({
            path: match[1].trim(),
            content: match[2].trim()
        }));
        
        const commands = [...implementation.matchAll(commandRegex)].map(match => match[1]);

        // Process files one at a time
        for (const file of files) {
            this.addMessageToChat('assistant', `📝 Creating file: ${file.path}`);
            try {
                await this.createFile(file.path, file.content);
                // Add a small delay after file creation
                await new Promise(resolve => setTimeout(resolve, 500));
            } catch (error) {
                this.addMessageToChat('assistant', `❌ Error creating file ${file.path}: ${error instanceof Error ? error.message : 'Unknown error'}`);
                return;
            }
        }

        // Process commands one at a time
        if (commands.length > 0) {
            for (const command of commands) {
                this.addMessageToChat('assistant', `⚡ Executing command: ${command}`);
                const success = await this.executeCommandWithRetry(command);
                
                if (!success && !step.isLongRunning) {
                    this.addMessageToChat('assistant', `❌ Command failed: ${command}`);
                    return;
                }
                
                // Add a delay between commands
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }

        this.addMessageToChat('assistant', `✅ Step ${stepIndex + 1} completed`);
    }

    private async createFile(filePath: string, content: string) {
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
        this.addMessageToChat('assistant', `✅ Created file: ${filePath}`);

        // Open the file in editor (one at a time)
        const document = await vscode.workspace.openTextDocument(fullPath);
        await vscode.window.showTextDocument(document, { preview: true });

        // Update the file tree view
        if (this.fileViewProvider) {
            await this.fileViewProvider.updateFileList();
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

    // Update deactivate to clean up terminals and save token counts
    public deactivate() {
        this.cleanupTerminals();
        if (this.tokenCountPanel) {
            this.tokenCountPanel.dispose();
        }
        // Save final token counts
        this._extensionContext.globalState.update('tokenCount', this.tokenCount);
    }

    private async handleCommandFailure(command: string, error: string, output: string): Promise<boolean> {
        try {
            this.addMessageToChat('assistant', '🔍 Analyzing command failure and attempting recovery...');
            
            // Comprehensive error analysis instructions with FULL error context
            const errorAnalysisInstructions = `
Command failed: "${command}"
Error message: "${error}"
Error output: "${output}"
Full output: "${output}"

Analyze the error and suggest a solution. If code changes are needed, specify them using the following format:

For file modifications:
EDIT_FILE: filename
START_BLOCK: [unique identifier or line number]
[new code]
END_BLOCK

For new files:
### filename.ext
content
%%%

For commands:
$ command

Focus on:
1. Understanding the root cause of the error
2. Suggesting specific fixes
3. Providing step-by-step recovery instructions`;

            const errorAnalysis = await this.openai.chat.completions.create({
                model: 'o3-mini',
                messages: [
                    { 
                        role: 'system', 
                        content: 'You are an error analysis and recovery expert. Analyze command failures and suggest specific solutions.' 
                    },
                    { role: 'user', content: errorAnalysisInstructions }
                ]
            });

            // Update token count
            await this.updateTokenCount(errorAnalysis);

            const solution = errorAnalysis.choices[0].message.content || '';
            this.addMessageToChat('assistant', '💡 Suggested recovery plan:\n' + solution);

            let recoverySuccessful = false;

            // Process file edits first
            const editMatches = solution.match(/EDIT_FILE:\s*([^\n]+)\nSTART_BLOCK:\s*([^\n]+)\n([\s\S]*?)\nEND_BLOCK/g);
            if (editMatches) {
                for (const match of editMatches) {
                    const [_, file, blockId, newCode] = match.match(/EDIT_FILE:\s*([^\n]+)\nSTART_BLOCK:\s*([^\n]+)\n([\s\S]*?)\nEND_BLOCK/) || [];
                    if (file && blockId && newCode) {
                        try {
                            await this.editFileBlock(file, blockId, newCode.trim());
                            recoverySuccessful = true;
                        } catch (error) {
                            this.addMessageToChat('assistant', `⚠️ Failed to edit ${file}: ${error}`);
                            // Continue with other recovery methods
                        }
                    }
                }
            }

            // Process new file creation
            try {
                await this.processFileCreationMarkers(solution);
                recoverySuccessful = true;
            } catch (error) {
                this.addMessageToChat('assistant', `⚠️ Failed to create new files: ${error}`);
                // Continue with recovery commands
            }

            // Process recovery commands
            const commandRegex = /\$ (.*)/g;
            const recoveryCommands = [...solution.matchAll(commandRegex)].map(match => match[1]);
            
            if (recoveryCommands.length > 0) {
                this.addMessageToChat('assistant', '🔧 Executing recovery commands:');
                const results = await Promise.all(recoveryCommands.map(async cmd => {
                    if (cmd === command) {
                        this.addMessageToChat('assistant', `⚠️ Skipping original failed command to prevent loop: ${cmd}`);
                        return { command: cmd, success: false };
                    }
                    this.addMessageToChat('assistant', `📝 Running: ${cmd}`);
                    return {
                        command: cmd,
                        success: await this.executeCommandWithRetry(cmd)
                    };
                }));

                // Check if any recovery command succeeded
                if (results.some(r => r.success)) {
                    recoverySuccessful = true;
                }
            }

            if (recoverySuccessful) {
                this.addMessageToChat('assistant', '✅ Recovery steps completed successfully');
                return true;
            }

            this.addMessageToChat('assistant', '❌ Recovery steps failed to resolve the issue');
            return false;
        } catch (error) {
            this.addMessageToChat('assistant', `❌ Error during recovery: ${error}`);
            return false;
        }
    }

    private async editFileBlock(filePath: string, blockIdentifier: string, newCode: string) {
        try {
            if (!vscode.workspace.workspaceFolders) {
                throw new Error('No workspace folder is open');
            }

            const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
            const fullPath = path.join(workspaceRoot, filePath);

            // Verify file exists
            if (!fs.existsSync(fullPath)) {
                throw new Error(`File does not exist: ${filePath}`);
            }

            // Read existing file content
            const content = await fs.promises.readFile(fullPath, 'utf8');
            let newContent = content;
            let edited = false;

            // Try to identify the block
            if (blockIdentifier.match(/^\d+$/)) {
                // Line number based replacement
                const lines = content.split('\n');
                const lineNum = parseInt(blockIdentifier, 10);
                if (lineNum > 0 && lineNum <= lines.length) {
                    if (lines[lineNum - 1] === newCode) {
                        this.addMessageToChat('assistant', `⚠️ No changes needed for line ${lineNum} in ${filePath}`);
                        return;
                    }
                    lines[lineNum - 1] = newCode;
                    newContent = lines.join('\n');
                    edited = true;
                } else {
                    throw new Error(`Invalid line number ${lineNum} for file ${filePath}`);
                }
            } else {
                // Block identifier based replacement
                const blockRegex = new RegExp(`// BEGIN ${blockIdentifier}[\\s\\S]*?// END ${blockIdentifier}`, 'g');
                const newBlock = `// BEGIN ${blockIdentifier}\n${newCode}\n// END ${blockIdentifier}`;
                
                if (!content.match(blockRegex)) {
                    throw new Error(`Block "${blockIdentifier}" not found in ${filePath}`);
                }

                const updatedContent = content.replace(blockRegex, newBlock);
                if (updatedContent === content) {
                    this.addMessageToChat('assistant', `⚠️ No changes needed for block "${blockIdentifier}" in ${filePath}`);
                    return;
                }
                newContent = updatedContent;
                edited = true;
            }

            if (edited) {
                // Write updated content
                await fs.promises.writeFile(fullPath, newContent);
                
                // Show success message
                this.addMessageToChat('assistant', `✅ Updated ${blockIdentifier} in ${filePath}`);

                // Open the file in editor
                const document = await vscode.workspace.openTextDocument(fullPath);
                await vscode.window.showTextDocument(document);
            }
        } catch (error) {
            throw new Error(`Failed to edit file ${filePath}: ${error instanceof Error ? error.message : 'Unknown error'}`);
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