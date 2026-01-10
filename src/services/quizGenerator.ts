import { ai, QUIZ_MODEL } from "../config/gemini.js";
import { generateQuizPrompt, getSystemInstruction } from "../prompts/quizPrompt.js";
import { Difficulty, QuizResponse, Language } from "../types/quiz.js";
import { chunkText } from "../utils/chunkText.js";

const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 2000;

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export const generateQuiz = async (
  fileText: string, 
  count: number, 
  difficulty: Difficulty,
  language: Language,
  avoidQuestions?: string[]
): Promise<QuizResponse> => {
  
  // Safety: Limit text size
  const safeText = chunkText(fileText);

  // Construct Prompt
  const prompt = generateQuizPrompt(safeText, count, difficulty, language, avoidQuestions);

  let attempt = 0;

  while (attempt <= MAX_RETRIES) {
    try {
      const response = await ai.models.generateContent({
        model: QUIZ_MODEL,
        contents: prompt,
        config: {
          responseMimeType: "application/json", // Force JSON
          systemInstruction: getSystemInstruction(),
          temperature: 0.3, 
        }
      });

      const responseText = response.text;

      if (!responseText) {
        throw new Error("Empty response from Gemini");
      }
      
      // Explicit check for insufficient content messages in raw text
      if (responseText.toLowerCase().includes("insufficient content")) {
        throw new Error("Insufficient content");
      }

      // Parse JSON
      const quizData: QuizResponse = JSON.parse(responseText);

      // Basic validation of structure
      if (!quizData.questions || !Array.isArray(quizData.questions)) {
         throw new Error("Invalid JSON structure received from AI");
      }

      // Check if the model returned an empty list, indicating it couldn't generate questions
      if (quizData.questions.length === 0) {
        throw new Error("Insufficient content");
      }

      return quizData;

    } catch (error: any) {
      attempt++;
      
      // If the error is our specific "Insufficient content" error, stop retrying and throw immediately
      if (error.message === "Insufficient content") {
        throw error;
      }

      // Check for Model Not Found (404)
      // This can happen if the API key doesn't have access to the model or the model name is incorrect
      const isModelNotFound = error.status === 404 || (error.message && error.message.includes("404"));
      
      if (isModelNotFound) {
        console.error(`Gemini Model Not Found (${QUIZ_MODEL}):`, error);
        throw new Error("The AI model is currently unavailable. Please contact support to check the configuration.");
      }

      // Check specifically for Rate Limit (429) or Service Unavailable (503)
      const isRateLimit = error.status === 429 || (error.message && error.message.includes("429"));
      const isServerOverload = error.status === 503 || (error.message && error.message.includes("503"));

      if ((isRateLimit || isServerOverload) && attempt <= MAX_RETRIES) {
        const waitTime = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt); // Exponential backoff: 4s, 8s, 16s...
        console.warn(`⚠️ Gemini Busy (Attempt ${attempt}/${MAX_RETRIES}). Retrying in ${waitTime}ms...`);
        await delay(waitTime);
        continue; // Retry
      }

      console.error("Gemini Generation Error:", error);
      
      // If we ran out of retries or it's a different error
      if (attempt > MAX_RETRIES && isRateLimit) {
         throw new Error("Gemini API Quota Exceeded. The system is currently busy. Please try again in a few minutes.");
      }
      
      // Fallback generic error
      throw new Error("Failed to generate quiz. The AI service might be busy or the file content is unclear.");
    }
  }

  throw new Error("Unexpected error in generation loop.");
};