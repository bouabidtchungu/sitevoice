// App.tsx - Chat session management
const initializeChatSession = (systemInstruction: string) => {
  // Store system instruction globally
  currentSystemInstruction = systemInstruction;
  
  // Initialize both voice and text sessions with same context
  voiceSessionManager.setSystemInstruction(systemInstruction);
  textSessionManager.setSystemInstruction(systemInstruction);
};

// services/geminiService.ts - TextSessionManager
class TextSessionManager {
  private systemInstruction: string = "";
  private chatHistory: any[] = [];
  
  setSystemInstruction(instruction: string) {
    this.systemInstruction = instruction;
  }
  
  async sendMessage(message: string) {
    // Include full context in every request
    const fullContext = {
      system_instruction: this.systemInstruction,
      history: this.chatHistory,
      new_message: message
    };
    
    // Call Gemini API with full context
    const response = await this.callGeminiAPI(fullContext);
    
    // Update chat history
    this.chatHistory.push({
      role: "user",
      content: message
    });
    
    this.chatHistory.push({
      role: "model",
      content: response
    });
    
    return response;
  }
  
  private async callGeminiAPI(context: any) {
    const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.VITE_GEMINI_API_KEY}`
      },
      body: JSON.stringify({
        contents: [{
          role: "user",
          parts: [{
            text: `
              System Instruction: ${context.system_instruction}
              
              Conversation History: ${JSON.stringify(context.history)}
              
              New Message: ${context.new_message}
              
              Respond based ONLY on the website content provided in the system instruction.
              Do not fabricate information. Be persuasive and sales-focused.
            `
          }]
        }],
        generationConfig: {
          temperature: 0.2, // As requested
          topK: 32,
          topP: 0.95,
        }
      })
    });
    
    const data = await response.json();
    return data.candidates[0].content.parts[0].text;
  }
}

// App.tsx - Handle chat messages
const handleChatSubmit = async () => {
  const message = chatInput.trim();
  if (!message) return;
  
  // Add user message to UI immediately
  addMessageToChat(message, 'user');
  setChatInput('');
  
  try {
    // Send to text session manager (which includes full context)
    const response = await textSessionManager.sendMessage(message);
    
    // Add AI response to UI
    addMessageToChat(response, 'ai');
    
  } catch (error) {
    console.error("Chat error:", error);
    addMessageToChat("Sorry, I encountered an error processing your request.", 'ai');
  }
};
