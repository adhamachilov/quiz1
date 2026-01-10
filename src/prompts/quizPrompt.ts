import { Difficulty } from "../types/quiz.js";

export const getSystemInstruction = (): string => {
  return `You are a strict, educational quiz generation engine. 
  Your output MUST be valid JSON only. Do not output markdown code blocks.`;
};

export const generateQuizPrompt = (content: string, count: number, difficulty: Difficulty, language: 'en' | 'uz' | 'ru'): string => {
  let difficultyGuidance = "";

  switch (difficulty) {
    case 'easy':
      difficultyGuidance = "Focus on basic definitions, vocabulary, and simple fact retrieval. Questions should be straightforward.";
      break;
    case 'exam':
      difficultyGuidance = "Focus on conceptual understanding, cause-and-effect, and standard curriculum-level questions. Resemble real exam questions.";
      break;
    case 'hard':
      difficultyGuidance = "Focus on application of concepts, tricky logic, edge cases, and synthesis of multiple ideas from the text.";
      break;
  }

  return `
Task: Generate ${count} multiple-choice questions based ONLY on the provided text content.

Language:
Output the question text, options, and explanation in the SAME language as the provided text content. Do NOT translate.
Expected language (best-effort hint): ${language === 'en' ? 'English' : language === 'uz' ? 'Uzbek' : 'Russian'}.

Context:
Difficulty Level: ${difficulty.toUpperCase()}
${difficultyGuidance}

Rules:
1. Use ONLY the provided text. Do not invent facts.
2. If the text is insufficient, return an empty questions array.
3. Each question must have exactly 4 options.
4. Provide a clear, educational explanation for why the correct answer is correct.
5. Keep the explanation short (max 180 characters).
6. Do NOT use robotic phrases like "the text states", "according to the text", "the passage says", or mention "the text/passage".
7. Write the explanation directly (no meta commentary).

Output Format (Strict JSON):
{
  "questions": [
    {
      "question": "string",
      "options": ["A", "B", "C", "D"],
      "correctIndex": 0, // 0-3
      "explanation": "string"
    }
  ]
}

Provided Text Content:
"${content}"
`;
};
