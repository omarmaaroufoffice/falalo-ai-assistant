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

interface EditBlock {
    type: 'replace' | 'add' | 'delete' | 'rewrite';
    file: string;
    description: string;
    content: string;
    startLine?: number;
    endLine?: number;
}

class EditManager {
    private static readonly EDIT_MARKERS = {
        REPLACE_BLOCK: '#replace-block#',
        ADD_BLOCK: '#add-block#',
        DELETE_BLOCK: '#delete-block#',
        REWRITE_FILE: '#rewrite-file#',
        END_BLOCK: '#end-block#'
    };

    private static validateEditBlock(edit: EditBlock): string[] {
        const errors: string[] = [];
        
        // Common validations
        if (!edit.file) {
            errors.push('File path is required');
            return errors;
        }
        if (!edit.type) {
            errors.push('Edit type is required');
            return errors;
        }
        if (!edit.description) {
            errors.push('Description is required');
            return errors;
        }

        // Type-specific validations
        switch (edit.type) {
            case 'replace':
                if (typeof edit.startLine !== 'number') errors.push('Start line is required for replace blocks');
                if (typeof edit.endLine !== 'number') errors.push('End line is required for replace blocks');
                if (typeof edit.content !== 'string') errors.push('Content is required for replace blocks');
                if (typeof edit.startLine === 'number' && typeof edit.endLine === 'number' && edit.startLine > edit.endLine) {
                    errors.push(`Invalid line range: ${edit.startLine}-${edit.endLine} (start line must be <= end line)`);
                }
                break;
            case 'add':
                if (typeof edit.startLine !== 'number') errors.push('Line number is required for add blocks');
                if (typeof edit.content !== 'string') errors.push('Content is required for add blocks');
                break;
            case 'delete':
                if (typeof edit.startLine !== 'number') errors.push('Start line is required for delete blocks');
                if (typeof edit.endLine !== 'number') errors.push('End line is required for delete blocks');
                if (typeof edit.startLine === 'number' && typeof edit.endLine === 'number' && edit.startLine > edit.endLine) {
                    errors.push(`Invalid line range: ${edit.startLine}-${edit.endLine} (start line must be <= end line)`);
                }
                break;
            case 'rewrite':
                if (typeof edit.content !== 'string') errors.push('Content is required for rewrite blocks');
                break;
            default:
                errors.push(`Invalid edit type: ${edit.type}`);
        }

        return errors;
    }

    private static parseEditBlocks(text: string): EditBlock[] {
        const blocks: EditBlock[] = [];
        const lines = text.split('\n');
        let currentBlock: Partial<EditBlock> | null = null;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();

            // Check for block start markers
            if (line.startsWith(this.EDIT_MARKERS.REPLACE_BLOCK) ||
                line.startsWith(this.EDIT_MARKERS.ADD_BLOCK) ||
                line.startsWith(this.EDIT_MARKERS.DELETE_BLOCK) ||
                line.startsWith(this.EDIT_MARKERS.REWRITE_FILE)) {
                
                // Parse the edit instruction
                const instruction = line.split('|').map(part => part.trim());
                if (instruction.length < 3) {
                    vscode.window.showErrorMessage(`Invalid edit block format at line ${i + 1}. Expected format: #marker#|file_path|description|[line_numbers]`);
                    continue;
                }

                const marker = instruction[0];
                const file = instruction[1];
                const description = instruction[2];
                
                currentBlock = {
                    type: marker === this.EDIT_MARKERS.REPLACE_BLOCK ? 'replace' :
                          marker === this.EDIT_MARKERS.ADD_BLOCK ? 'add' :
                          marker === this.EDIT_MARKERS.DELETE_BLOCK ? 'delete' : 'rewrite',
                    file,
                    description,
                    content: ''
                } as EditBlock;

                // Parse line numbers for replace, add, and delete operations
                if (currentBlock.type !== 'rewrite' && instruction.length > 3) {
                    const lineRange = instruction[3].split('-').map(num => {
                        const parsed = parseInt(num, 10);
                        return isNaN(parsed) ? undefined : parsed;
                    });
                    
                    if (lineRange.some(num => num === undefined)) {
                        vscode.window.showErrorMessage(`Invalid line numbers at line ${i + 1}: ${instruction[3]}`);
                        continue;
                    }

                    currentBlock.startLine = lineRange[0]!;
                    currentBlock.endLine = lineRange[1] || lineRange[0]!;
                }

                continue;
            }

            // Check for block end
            if (line === this.EDIT_MARKERS.END_BLOCK && currentBlock) {
                if (currentBlock.content?.trim()) {
                    currentBlock.content = currentBlock.content.trim();
                    blocks.push(currentBlock as EditBlock);
                } else {
                    vscode.window.showWarningMessage(`Empty content block for ${currentBlock.file}`);
                }
                currentBlock = null;
                continue;
            }

            // Accumulate content if we're in a block
            if (currentBlock) {
                currentBlock.content = (currentBlock.content || '') + line + '\n';
            }
        }

        // Check for unclosed blocks
        if (currentBlock) {
            vscode.window.showErrorMessage(`Unclosed edit block for ${currentBlock.file}. Missing ${this.EDIT_MARKERS.END_BLOCK}`);
        }

        return blocks;
    }

    public static async processEditMarkers(text: string): Promise<{ success: boolean; errors: string[] }> {
        const editBlocks = this.parseEditBlocks(text);
        const errors: string[] = [];
        
        for (const edit of editBlocks) {
            try {
                // Validate edit block parameters
                const validationErrors = this.validateEditBlock(edit);
                if (validationErrors.length > 0) {
                    throw new Error(`Invalid edit block for ${edit.file || 'unknown file'}:\n${validationErrors.join('\n')}`);
                }

                // Check if file exists and create if necessary
                if (!vscode.workspace.workspaceFolders) {
                    throw new Error('No workspace folder is open');
                }
                const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
                const filePath = path.join(workspaceRoot, edit.file);

                // Create parent directories if they don't exist
                await fs.promises.mkdir(path.dirname(filePath), { recursive: true });

                // For non-rewrite operations, create the file if it doesn't exist
                if (!fs.existsSync(filePath) && edit.type !== 'rewrite') {
                    await fs.promises.writeFile(filePath, '');
                    vscode.window.showInformationMessage(`Created new file: ${edit.file}`);
                }

                // Process the edit based on type
                switch (edit.type) {
                    case 'replace':
                        await this.handleReplaceBlock(edit as EditBlock & { type: 'replace' });
                        break;
                    case 'add':
                        await this.handleAddBlock(edit as EditBlock & { type: 'add' });
                        break;
                    case 'delete':
                        await this.handleDeleteBlock(edit as EditBlock & { type: 'delete' });
                        break;
                    case 'rewrite':
                        await this.handleRewriteFile(edit as EditBlock & { type: 'rewrite' });
                        break;
                }
            } catch (error) {
                const errorMessage = `Failed to apply edit to ${edit.file || 'unknown file'}: ${error instanceof Error ? error.message : 'Unknown error'}`;
                vscode.window.showErrorMessage(errorMessage);
                errors.push(errorMessage);
            }
        }

        return {
            success: errors.length === 0,
            errors
        };
    }

    private static async handleReplaceBlock(edit: EditBlock & { type: 'replace' }): Promise<void> {
        if (!vscode.workspace.workspaceFolders) {
            throw new Error('No workspace folder is open');
        }

        const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
        const filePath = path.join(workspaceRoot, edit.file);

        // Read the file content
        const fileContent = await fs.promises.readFile(filePath, 'utf8');
        const lines = fileContent.split('\n');

        // Validate line numbers
        if (!edit.startLine || edit.startLine < 1) {
            throw new Error(`Invalid start line: ${edit.startLine} (must be >= 1)`);
        }
        if (!edit.endLine || edit.endLine > lines.length) {
            // If end line is beyond file length, adjust it
            edit.endLine = lines.length;
            vscode.window.showWarningMessage(`Adjusted end line to file length (${lines.length}) for ${edit.file}`);
        }

        // Replace the specified lines
        const newContent = [
            ...lines.slice(0, edit.startLine - 1),
            ...edit.content.trim().split('\n'),
            ...lines.slice(edit.endLine)
        ].join('\n');

        // Write the file
        await fs.promises.writeFile(filePath, newContent);
        
        // Show success message
        vscode.window.showInformationMessage(`Replaced lines ${edit.startLine}-${edit.endLine} in ${edit.file}: ${edit.description}`);
    }

    private static async handleAddBlock(edit: EditBlock & { type: 'add' }): Promise<void> {
        if (!vscode.workspace.workspaceFolders) {
            throw new Error('No workspace folder is open');
        }

        const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
        const filePath = path.join(workspaceRoot, edit.file);

        // Read the file content
        const fileContent = await fs.promises.readFile(filePath, 'utf8');
        const lines = fileContent.split('\n');

        // Validate line number
        if (!edit.startLine || edit.startLine < 1) {
            throw new Error(`Invalid line number: ${edit.startLine} (must be >= 1)`);
        }
        if (edit.startLine > lines.length + 1) {
            // If start line is beyond file length, adjust it
            edit.startLine = lines.length + 1;
            vscode.window.showWarningMessage(`Adjusted insertion point to end of file (${lines.length + 1}) for ${edit.file}`);
        }

        // Add the new content
        const newContent = [
            ...lines.slice(0, edit.startLine - 1),
            edit.content.trim(),
            ...lines.slice(edit.startLine - 1)
        ].join('\n');

        // Write the file
        await fs.promises.writeFile(filePath, newContent);
        
        // Show success message
        vscode.window.showInformationMessage(`Added content at line ${edit.startLine} in ${edit.file}: ${edit.description}`);
    }

    private static async handleDeleteBlock(edit: EditBlock & { type: 'delete' }): Promise<void> {
        if (!vscode.workspace.workspaceFolders) {
            throw new Error('No workspace folder is open');
        }

        const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
        const filePath = path.join(workspaceRoot, edit.file);

        // Read the file content
        const fileContent = await fs.promises.readFile(filePath, 'utf8');
        const lines = fileContent.split('\n');

        // Validate line numbers
        if (!edit.startLine || !edit.endLine || edit.startLine < 1 || edit.endLine > lines.length) {
            throw new Error(`Invalid line range: ${edit.startLine}-${edit.endLine}`);
        }

        // Remove the specified lines
        const newContent = [
            ...lines.slice(0, edit.startLine - 1),
            ...lines.slice(edit.endLine)
        ].join('\n');

        // Write the file
        await fs.promises.writeFile(filePath, newContent);
        
        // Show success message
        vscode.window.showInformationMessage(`Deleted lines ${edit.startLine}-${edit.endLine} from ${edit.file}: ${edit.description}`);
    }

    private static async handleRewriteFile(edit: EditBlock & { type: 'rewrite' }): Promise<void> {
        if (!vscode.workspace.workspaceFolders) {
            throw new Error('No workspace folder is open');
        }

        const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
        const filePath = path.join(workspaceRoot, edit.file);

        // Create directory if it doesn't exist
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });

        // Write the new content
        await fs.promises.writeFile(filePath, edit.content.trim());
        
        // Show success message
        vscode.window.showInformationMessage(`Rewritten file ${edit.file}: ${edit.description}`);
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

            // Stage 1: Planning Phase
            const planningInstructions = `You are a planning AI. Your role is to:
1. Analyze the user's request and break it down into specific, actionable steps
2. Each step should be clear and achievable
3. Steps should be in logical order
4. Include any dependencies or prerequisites
5. Format your response as a numbered list
6. Be specific about file operations, code changes, or other actions needed

When editing files, use these special markers:
1. Replace a block of code:
   #replace-block#|file_path|description|start_line-end_line
   new code here
   #end-block#

2. Add new code:
   #add-block#|file_path|description|line_number
   code to add
   #end-block#

3. Delete code:
   #delete-block#|file_path|description|start_line-end_line
   #end-block#

4. Rewrite entire file:
   #rewrite-file#|file_path|description
   new file content
   #end-block#

Note: If a file doesn't exist, it will be created automatically. Line numbers will be adjusted if they're out of range.

You have the following context about the workspace:${contextInfo}

Please analyze this request and provide a step-by-step plan:
${text}`;

            // Get plan from AI
            const planningModel = this.genAI.getGenerativeModel({ model: 'gemini-pro' });
            const planResult = await planningModel.generateContent(planningInstructions);
            const plan = planResult.response.text();
            
            // Show the plan to the user
            this.addMessageToChat('assistant', '🔍 Planning Phase:\n\n' + plan);

            // Stage 2: Execution Phase
            const steps = plan.split('\n').filter(line => /^\d+\./.test(line));
            let hasErrors = false;
            
            for (const step of steps) {
                let retryCount = 0;
                let success = false;
                let lastErrors: string[] = [];

                while (!success && retryCount < 4) {
                    // Prepare execution instructions for each step
                    let executionInstructions = `You are an execution AI. Your role is to implement the following step:

${step}

When editing files, use these special markers:
1. Replace a block of code:
   #replace-block#|file_path|description|start_line-end_line
   new code here
   #end-block#

2. Add new code:
   #add-block#|file_path|description|line_number
   code to add
   #end-block#

3. Delete code:
   #delete-block#|file_path|description|start_line-end_line
   #end-block#

4. Rewrite entire file:
   #rewrite-file#|file_path|description
   new file content
   #end-block#

Note: If a file doesn't exist, it will be created automatically. Line numbers will be adjusted if they're out of range.`;

                    // Add error feedback for retries
                    if (retryCount > 0) {
                        executionInstructions += `\n\nPrevious attempt failed with these errors:
${lastErrors.map(err => `- ${err}`).join('\n')}

Please adjust your implementation to fix these issues.`;
                    }

                    executionInstructions += `\n\nYou have the following context about the workspace:${contextInfo}\n\nPlease implement this step now.`;

                    // Get implementation from AI
                    const executionModel = this.genAI.getGenerativeModel({ model: 'gemini-pro' });
                    const executionResult = await executionModel.generateContent(executionInstructions);
                    const implementation = executionResult.response.text();
                    
                    // Show the implementation
                    if (retryCount === 0) {
                        this.addMessageToChat('assistant', `📝 Executing Step: ${step}\n\n${implementation}`);
                    } else {
                        this.addMessageToChat('assistant', `🔄 Retry #${retryCount} for Step: ${step}\n\n${implementation}`);
                    }

                    // Process any file creation markers in the implementation
                    await this.processFileCreationMarkers(implementation);

                    // Process any edit markers in the implementation and collect errors
                    const editResult = await EditManager.processEditMarkers(implementation);
                    if (!editResult.success) {
                        hasErrors = true;
                        lastErrors = editResult.errors;
                        retryCount++;
                        
                        if (retryCount < 4) {
                            this.addMessageToChat('assistant', `⚠️ Attempt failed with errors. Retrying (${retryCount}/3):\n${lastErrors.join('\n')}`);
                        } else {
                            this.addMessageToChat('assistant', '❌ Maximum retries reached. Errors:\n' + lastErrors.join('\n'));
                        }
                    } else {
                        success = true;
                        if (retryCount > 0) {
                            this.addMessageToChat('assistant', '✅ Successfully fixed the errors on retry!');
                        }
                    }
                }
            }

            // Final completion message
            if (hasErrors) {
                this.addMessageToChat('assistant', '⚠️ Task completed with some errors. Please review the messages above.');
            } else {
                this.addMessageToChat('assistant', '✅ All steps have been completed successfully!');
            }
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