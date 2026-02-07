// services/geminiService.ts - VoiceSessionManager
class VoiceSessionManager {
  private mediaRecorder: MediaRecorder | null = null;
  private audioStream: MediaStream | null = null;
  private isRecording = false;
  private audioChunks: Blob[] = [];
  
  async initializeMicrophone() {
    try {
      // Step 1: Request microphone permissions
      this.audioStream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: 16000 // Optimal for speech recognition
        }
      });
      
      // Step 2: Set up MediaRecorder
      this.mediaRecorder = new MediaRecorder(this.audioStream, {
        mimeType: 'audio/webm' // Compatible with Gemini API
      });
      
      // Step 3: Handle audio data chunks
      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          this.audioChunks.push(event.data);
        }
      };
      
      // Step 4: Process audio chunks periodically
      this.mediaRecorder.onstop = () => {
        this.processAudioChunks();
      };
      
      console.log("Microphone initialized successfully");
      return true;
      
    } catch (error) {
      console.error("Microphone initialization failed:", error);
      throw new Error("Failed to access microphone. Please check permissions.");
    }
  }
  
  async startRecording() {
    if (!this.mediaRecorder) {
      throw new Error("Microphone not initialized");
    }
    
    if (this.isRecording) {
      return;
    }
    
    try {
      // Clear previous chunks
      this.audioChunks = [];
      
      // Start recording
      this.mediaRecorder.start(1000); // Send data every second
      this.isRecording = true;
      
      console.log("Started recording audio");
    } catch (error) {
      console.error("Recording failed:", error);
      throw new Error("Failed to start recording");
    }
  }
  
  stopRecording() {
    if (this.mediaRecorder && this.isRecording) {
      this.mediaRecorder.stop();
      this.isRecording = false;
      
      // Stop all audio tracks
      if (this.audioStream) {
        this.audioStream.getTracks().forEach(track => track.stop());
      }
      
      console.log("Stopped recording audio");
    }
  }
  
  private async processAudioChunks() {
    if (this.audioChunks.length === 0) return;
    
    try {
      // Combine audio chunks into single blob
      const audioBlob = new Blob(this.audioChunks, { type: 'audio/webm' });
      
      // Convert to base64 for API transmission
      const base64Audio = await this.blobToBase64(audioBlob);
      
      // Send to Gemini Multimodal Live API
      await this.sendAudioToGemini(base64Audio);
      
      // Clear chunks for next recording
      this.audioChunks = [];
      
    } catch (error) {
      console.error("Audio processing failed:", error);
    }
  }
  
  private blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }
  
  private async sendAudioToGemini(base64Audio: string) {
    // Implementation depends on Gemini API specifics
    // This is a simplified example
    const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-pro-live:streamGenerateContent', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.VITE_GEMINI_API_KEY}`
      },
      body: JSON.stringify({
        contents: [{
          parts: [{
            inline_data: {
              mime_type: "audio/webm",
              data: base64Audio.split(',')[1] // Remove data URL prefix
            }
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
    // Process response...
  }
}

// App.tsx - Microphone controls
const handleStartListening = async () => {
  try {
    setIsListening(true);
    setListeningStatus("Listening... Speak now");
    
    // Initialize microphone if needed
    if (!voiceSessionManager.isInitialized()) {
      await voiceSessionManager.initializeMicrophone();
    }
    
    // Start recording
    await voiceSessionManager.startRecording();
    
  } catch (error) {
    console.error("Failed to start listening:", error);
    setListeningStatus(`Error: ${(error as Error).message}`);
    setIsListening(false);
  }
};

const handleStopListening = () => {
  voiceSessionManager.stopRecording();
  setIsListening(false);
  setListeningStatus("Voice recognition paused");
};
