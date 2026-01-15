import { Context } from 'telegraf';

// Max file size in bytes (10MB)
const MAX_FILE_SIZE = 10 * 1024 * 1024;

export const isValidFileType = (mimeType?: string): boolean => {
  if (!mimeType) return false;
  const validTypes = [
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // docx
    'application/vnd.openxmlformats-officedocument.presentationml.presentation', // pptx
    'text/plain' // fallback
  ];
  return validTypes.includes(mimeType);
};

export const isValidFileSize = (fileSize?: number): boolean => {
  if (!fileSize) return false;
  return fileSize <= MAX_FILE_SIZE;
};

export const handleError = (ctx: Context, error: unknown, message: string) => {
  console.error(message, error);
  
  let userMessage = `⚠️ Error: ${message}.`;

  if (error instanceof Error) {
    if (
      error.message.includes('Failed to parse the PPTX file') ||
      error.message.includes('Empty PPTX content') ||
      error.message.includes('Unsupported file type') ||
      error.message.includes('Failed to extract text from file')
    ) {
      userMessage = `⚠️ ${error.message}`;
    } else 
    if (error.message.includes("Quota Exceeded") || error.message.includes("429") || error.message.includes("Traffic limit") || error.message.includes("RESOURCE_EXHAUSTED")) {
      const msg = error.message || '';
      let waitSeconds: string | undefined;
      const m1 = msg.match(/Please retry in\s+([0-9.]+)s/i);
      if (m1?.[1]) waitSeconds = m1[1];
      const m2 = msg.match(/retryDelay"\s*:\s*"(\d+)s"/i);
      if (!waitSeconds && m2?.[1]) waitSeconds = m2[1];
      const m3 = msg.match(/retry in\s+([0-9.]+)s/i);
      if (!waitSeconds && m3?.[1]) waitSeconds = m3[1];
      userMessage = waitSeconds
        ? `⚠️ Traffic Limit Reached. Please wait ${waitSeconds}s and try again.`
        : "⚠️ Traffic Limit Reached. The AI is busy right now. Please wait and try again.";
    } else if (error.message.includes("Insufficient content")) {
       userMessage = "⚠️ The file didn't contain enough readable text to generate questions.";
    } else if (error.message.includes("AI model is currently unavailable")) {
        userMessage = "⚠️ System Configuration Error: The AI model is currently unavailable. Please contact the bot administrator.";
    } else if (error.message && !userMessage.includes(error.message)) {
        userMessage = `⚠️ Error: ${message}.\n${error.message}`;
    }
  }

  ctx.reply(userMessage);
};