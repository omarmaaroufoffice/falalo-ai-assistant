import * as vscode from 'vscode';
import { GoogleAuth } from 'google-auth-library';
import { GoogleGenerativeAI } from '@google/generative-ai';
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
    private genAI: GoogleGenerativeAI;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _extensionContext: vscode.ExtensionContext,
        private readonly contextManager: ContextManager
    ) {
        const config = vscode.workspace.getConfiguration('falalo');
        const apiKey = config.get('googleApiKey', '');
        this.genAI = new GoogleGenerativeAI(apiKey);
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

            // Prepare the message with file creation instructions and context
            const aiInstructions = `You have the following context about the workspace:${contextInfo}

When responding with code or file content:
1. First provide your normal response with any explanations and code blocks
2. AFTER your response, if files need to be created, add them using this format:

- Start each file section with "###" followed by the filename
- Put the file content on the next line
- End with "%%%" on its own line
- Leave one blank line between multiple files

For example, your response should look like this:

Here's a simple HTML page that does X and Y...

\`\`\`html
<!DOCTYPE html>
<html>
<head>
    <title>Example</title>
</head>
<body>
    <h1>Hello</h1>
</body>
</html>
\`\`\`

I'll create this file for you:

### index.html
<!DOCTYPE html>
<html>
<head>
    <title>Example</title>
</head>
<body>
    <h1>Hello</h1>
</body>
</html>
%%%

Now, please respond to the following request:

${text}`;

            // Get response from Google AI
            const model = this.genAI.getGenerativeModel({ model: 'gemini-pro' });
            const result = await model.generateContent(aiInstructions);
            const response = result.response;
            const responseText = response.text();
            
            // Add AI response to chat
            this.addMessageToChat('assistant', responseText);

            // Process any file creation markers in the response
            await this.processFileCreationMarkers(responseText);
        } catch (error) {
            vscode.window.showErrorMessage(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    private async processFileCreationMarkers(text: string) {
        const fileRegex = /###\s*([^\n]+)\s*\n([\s\S]*?)%%%/g;
        let match;

        while ((match = fileRegex.exec(text)) !== null) {
            const [_, filePath, content] = match;
            await this.createFile(filePath.trim(), content.trim());
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

            // Show success message
            vscode.window.showInformationMessage(`Created file: ${filePath}`);

            // Open the file in editor
            const document = await vscode.workspace.openTextDocument(fullPath);
            await vscode.window.showTextDocument(document);
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
                    body {
                        padding: 10px;
                        color: var(--vscode-editor-foreground);
                        background-color: var(--vscode-editor-background);
                        display: flex;
                        flex-direction: column;
                        height: 100vh;
                        margin: 0;
                    }
                    .chat-container {
                        display: flex;
                        flex-direction: column;
                        height: 100%;
                    }
                    .messages {
                        flex-grow: 1;
                        overflow-y: auto;
                        margin-bottom: 10px;
                        padding-right: 5px;
                    }
                    .message {
                        margin: 5px 0;
                        padding: 8px;
                        border-radius: 4px;
                        max-width: 95%;
                        word-wrap: break-word;
                    }
                    .user-message {
                        background-color: var(--vscode-editor-selectionBackground);
                        margin-left: auto;
                    }
                    .assistant-message {
                        background-color: var(--vscode-editor-inactiveSelectionBackground);
                        margin-right: auto;
                    }
                    .input-container {
                        display: flex;
                        flex-direction: column;
                        gap: 8px;
                        min-height: 100px;
                        max-height: 200px;
                    }
                    .file-format-help {
                        font-size: 12px;
                        padding: 8px;
                        background-color: var(--vscode-editor-inactiveSelectionBackground);
                        border-radius: 4px;
                        margin-bottom: 8px;
                    }
                    .file-format-help pre {
                        margin: 6px 0;
                        padding: 6px;
                        background-color: var(--vscode-editor-background);
                        border-radius: 3px;
                        font-size: 11px;
                    }
                    .input-row {
                        display: flex;
                        gap: 8px;
                    }
                    textarea {
                        flex-grow: 1;
                        padding: 6px;
                        border: 1px solid var(--vscode-input-border);
                        background: var(--vscode-input-background);
                        color: var(--vscode-input-foreground);
                        resize: vertical;
                        min-height: 60px;
                        font-family: var(--vscode-editor-font-family);
                        font-size: var(--vscode-editor-font-size);
                    }
                    button {
                        padding: 6px 12px;
                        background: var(--vscode-button-background);
                        color: var(--vscode-button-foreground);
                        border: none;
                        cursor: pointer;
                        align-self: flex-end;
                    }
                    button:hover {
                        background: var(--vscode-button-hoverBackground);
                    }
                    .help-toggle {
                        font-size: 11px;
                        color: var(--vscode-textLink-foreground);
                        cursor: pointer;
                        text-decoration: underline;
                        margin-bottom: 6px;
                    }
                    pre {
                        white-space: pre-wrap;
                        word-wrap: break-word;
                    }
                    code {
                        font-family: var(--vscode-editor-font-family);
                        font-size: var(--vscode-editor-font-size);
                    }
                </style>
            </head>
            <body>
                <div class="chat-container">
                    <div class="messages" id="messages"></div>
                    <div class="input-container">
                        <div class="help-toggle" id="helpToggle">Show file creation format help</div>
                        <div class="file-format-help" id="fileFormatHelp" style="display: none;">
                            <strong>File Creation Format:</strong>
                            <p>To create files, use the following format in your request:</p>
                            <pre>### filename.ext
file content here
%%%</pre>
                            <p>Example:</p>
                            <pre>### src/components/Button.tsx
import React from 'react';

export const Button = () => {
    return <button>Click me</button>;
}
%%%</pre>
                            <p>You can create multiple files by using multiple blocks:</p>
                            <pre>### file1.js
console.log('Hello');
%%%

### file2.css
.button { color: blue; }
%%%</pre>
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
                    const document = await vscode.workspace.openTextDocument(message.path);
                    await vscode.window.showTextDocument(document);
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

    private async updateFileList() {
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
                    body {
                        padding: 10px;
                        color: var(--vscode-editor-foreground);
                        background-color: var(--vscode-editor-background);
                        font-family: var(--vscode-editor-font-family);
                        font-size: var(--vscode-editor-font-size);
                    }
                    .file-tree {
                        user-select: none;
                    }
                    .directory {
                        margin-left: 20px;
                    }
                    .directory-name {
                        cursor: pointer;
                        padding: 2px 0;
                        display: flex;
                        align-items: center;
                    }
                    .directory-name:hover {
                        background-color: var(--vscode-list-hoverBackground);
                    }
                    .file {
                        margin-left: 20px;
                        cursor: pointer;
                        padding: 2px 0;
                        display: flex;
                        align-items: center;
                    }
                    .file:hover {
                        background-color: var(--vscode-list-hoverBackground);
                    }
                    .collapsed {
                        display: none;
                    }
                    .icon {
                        margin-right: 5px;
                    }
                    .included {
                        color: #0098ff;
                    }
                    .excluded {
                        color: #ff8c00;
                    }
                    .context-indicator {
                        width: 8px;
                        height: 8px;
                        border-radius: 50%;
                        margin-left: 5px;
                    }
                    .context-indicator.included {
                        background-color: #0098ff;
                    }
                    .context-indicator.excluded {
                        background-color: #ff8c00;
                    }
                    .actions {
                        margin-left: auto;
                        display: flex;
                        gap: 5px;
                    }
                    .action-button {
                        padding: 2px 4px;
                        border-radius: 3px;
                        font-size: 10px;
                        cursor: pointer;
                        opacity: 0;
                        transition: opacity 0.2s;
                    }
                    .file:hover .action-button,
                    .directory-name:hover .action-button {
                        opacity: 1;
                    }
                    .include-button {
                        background-color: #0098ff33;
                        color: #0098ff;
                    }
                    .exclude-button {
                        background-color: #ff8c0033;
                        color: #ff8c00;
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
                                
                                fileDiv.addEventListener('click', () => {
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