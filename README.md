# Falalo AI Assistant

A powerful VS Code extension that provides an AI-powered coding assistant with context-aware chat functionality.

## Features

- 🤖 AI-powered chat interface
- 📝 Context-aware code understanding
- 🔍 Smart file inclusion/exclusion
- ⚡ Quick access with keyboard shortcuts
- 🎨 Beautiful VS Code-themed UI
- 📁 Automatic file creation from chat

## Requirements

- VS Code 1.80.0 or higher
- Google AI API key
- Workspace trust enabled (for file creation)

## Installation

1. Install the extension from the VS Code Marketplace
2. Get a Google AI API key
3. Add your API key to VS Code settings:
   - Open VS Code settings
   - Search for "Falalo"
   - Enter your Google AI API key in the "Google Api Key" setting

## Usage

### Starting a Chat
- Use Command Palette (Cmd/Ctrl + Shift + P) and type "Falalo: Start AI Chat"
- Or use the keyboard shortcut: Cmd/Ctrl + Shift + A

### Managing Context
- Include files: Command Palette > "Falalo: Include in Chat Context"
- Exclude files: Command Palette > "Falalo: Exclude from Chat Context"
- View context: Command Palette > "Falalo: Show Context Items"

### File Creation
The extension automatically creates files when it detects content between special markers in the AI's response:

```
### filename.ext
file content here
%%%
```

Multiple files can be created in a single response:

```
### src/components/Button.tsx
import React from 'react';
// component code
%%%

### styles/button.css
.button {
  // styles
}
%%%
```

The extension will:
- Create necessary directories
- Create the file with the specified content
- Open the file in the editor
- Show a success notification

## Extension Settings

This extension contributes the following settings:

* `falalo.maxContextFiles`: Maximum number of files to include in chat context
* `falalo.contextInclusions`: Glob patterns for files to include in context
* `falalo.contextExclusions`: Glob patterns for files to exclude from context
* `falalo.googleApiKey`: Google AI API Key for the chat functionality

## Release Notes

### 0.1.0

Initial release of Falalo AI Assistant:
- AI-powered chat interface
- Context management
- File inclusion/exclusion
- Google AI integration
- Automatic file creation from chat responses

## License

MIT 