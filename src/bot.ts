import { Telegraf, Context, Markup } from 'telegraf';
import { message } from 'telegraf/filters';
import { config } from './config/env.js';
import { parseFileContent } from './services/fileParser.js';
import { generateQuiz, getLlmStats, resetLlmStats } from './services/quizGenerator.js';
import { savePoll, getPoll, getPollAsync } from './services/pollService.js';
import { isValidFileType, isValidFileSize, handleError } from './utils/validators.js';
import { UserSession, Difficulty, Language, QuestionType } from './types/quiz.js';
import { getMaxInputChars } from './utils/chunkText.js';
import { Buffer } from 'buffer';
import https from 'https';
import dns from 'dns';
import ProxyAgent from 'proxy-agent';
import { ProxyAgent as UndiciProxyAgent } from 'undici';
import { dbEnabled } from './services/db.js';
import { getSession, setSession, listUserIds, getStats, getPlanStats, getActiveUsersBetween } from './services/sessionStore.js';

const ADMIN_ID = Number((process.env.ADMIN_ID || '').trim());
if (!Number.isFinite(ADMIN_ID) || ADMIN_ID <= 0) {
  throw new Error('ADMIN_ID missing or invalid');
}
const ADMIN_CONTACT = '@a_adham';

const getTextLimitVars = () => {
  const maxChars = getMaxInputChars();
  const maxWords = Math.max(1, Math.round(maxChars / 5));
  const minChars = 1000;
  const minWords = 200;
  return { maxChars, maxWords, minChars, minWords };
};

const getUzbekistanTodayRange = (nowMs: number = Date.now()): { startMs: number; endMs: number } => {
  const dayKey = getDayKeyUzbekistan(nowMs);
  const startMs = new Date(`${dayKey}T00:00:00.000Z`).getTime() - UZ_TZ_OFFSET_MS;
  const endMs = startMs + 24 * 60 * 60 * 1000;
  return { startMs, endMs };
};

const DEFAULT_MAX_FILE_TEXT_CHARS = 250 * 1000;
const MAX_FILE_TEXT_CHARS = Math.max(
  50_000,
  parseInt(process.env.MAX_FILE_TEXT_CHARS || String(DEFAULT_MAX_FILE_TEXT_CHARS), 10) ||
    DEFAULT_MAX_FILE_TEXT_CHARS
);

const getFileWindowCount = (textLen: number): number => {
  const { maxChars } = getTextLimitVars();
  return Math.max(1, Math.ceil(Math.max(0, textLen) / Math.max(1, maxChars)));
};

// Extend Context for Session
interface MyContext extends Context {
  session?: UserSession;
}

const messages: Record<Language, Record<string, string>> = {
  en: {
    chooseLanguage: '🌐 Choose language:',
    uploadPrompt:
      '📤 Please upload your file now.\n\n' +
      'Limits:\n' +
      '- Max file size: 10MB\n' +
      '- Max text processed per quiz: {maxChars} characters (≈{maxWords} words)\n' +
      '- For best results: {minWords}+ words (≈{minChars}+ characters) of readable text',
    changeLanguageBtn: '🌐 Change language',
    welcome:
      "👋 Welcome to the AI Quiz Bot!\n\n" +
      "1️⃣ Upload a lesson file (PDF, DOCX, PPTX).\n" +
      "2️⃣ Choose how many questions you want.\n" +
      "3️⃣ Choose a difficulty level.\n" +
      "4️⃣ I'll generate a quiz to test your knowledge!\n\n" +
      '📤 Please upload your file now.',
    downloading: '⏳ Downloading and extracting text...',
    invalidType: '❌ Invalid file type. Please upload PDF, DOCX, or PPTX.',
    invalidSize: '❌ File too large. Max size is 10MB.',
    notEnoughText:
      '⚠️ Could not extract enough text from this file.\n\n' +
      'Try another file with more readable text (recommended: {minWords}+ words / {minChars}+ characters).',
    textTooLong:
      '⚠️ This file contains too much text to process reliably.\n\n' +
      'Please upload a smaller file or split it into parts.\n' +
      'Max supported extracted text: {maxTotalChars} characters.',
    longTextNotice:
      'ℹ️ Your file is long. I will generate questions using only Part {part}/{parts}.\n\n' +
      'Per quiz limit: {maxChars} characters (≈{maxWords} words).\n' +
      'You can switch parts using the button below.',
    choosePartBtn: '📄 Choose part',
    choosePartTitle: '📄 Choose which part of the file to use:',
    selectedPart: '✅ Selected Part {part}/{parts}.',
    partPreviewTitle: '📄 Part {part}/{parts}',
    partPreviewHint: 'Preview (first lines):',
    partPrevBtn: '⬅️ Prev',
    partNextBtn: 'Next ➡️',
    partUseBtn: '✅ Use this part',
    chooseQuestionType:
      '📝 Choose question type:\n\n' +
      '🗳 Poll (Options): tap A/B/C/D.\n' +
      '⌨️ Open (Type): type your answer.\n' +
      '✅ True / False / NG: choose True/False if stated; choose NG if the text does not mention it.',
    questionTypePollBtn: '🗳 Poll (Options)',
    questionTypeOpenBtn: '⌨️ Open (Type answer)',
    questionTypeTfngBtn: '✅ True / False / NG',
    selectedQuestionTypePoll: '✅ Selected: Poll questions (with options).',
    selectedQuestionTypeOpen: '✅ Selected: Open questions (type your answer).',
    selectedQuestionTypeTfng: '✅ Selected: True / False / NG.',
    howMany: '✅ File processed! How many questions do you want?',
    chooseDifficulty: '🧠 Choose difficulty level:',
    analyzing: '🤖 Analyzing content and generating questions... This may take a few seconds.',
    insufficient: '⚠️ Gemini could not generate questions from this content. Try a file with more clear text.',
    answerToContinue: '🎉 Generated {n} questions! Answer each question to get the next one.',
    finishedScore: '✅ Quiz finished! Your score: {score}/{total}',
    openAnswerPrompt: '✍️ Type your answer now (text).',
    openCorrect: '✅ Correct!\n\n{explanation}',
    openWrong: '❌ Wrong.\n✅ Correct answer: {answer}\n\n{explanation}',
    busy: '⏳ Please wait… I\'m still processing your previous request.',
    noMoreUnique: '⚠️ I couldn\'t generate more unique questions from this file. Try uploading a new file or changing difficulty.',
    morePrompt: 'What next?',
    moreBtn: 'Generate more questions',
    newFileBtn: 'Upload new file',
    needLanguage: '🌐 Please choose a language first.',
    sessionExpired: '⚠️ Session expired. Please upload the file again.',
    selectedCount: '✅ Selected: {n} questions.',
    selectedDifficulty: '✅ Selected: {difficulty} mode.',
    diff_easy: 'Easy',
    diff_exam: 'Exam',
    diff_hard: 'Hard',
    easyBtn: '🟢 Easy (Definitions)',
    examBtn: '🟡 Exam (Concepts)',
    hardBtn: '🔴 Hard (Application)',
    unauthorized: '❌ Unauthorized.',
    adminPanel: '🛠 Admin panel',
    adminStats: '📊 Stats',
    adminLlm: '🧠 LLM diagnostics',
    adminTokens: '🧾 Token usage',
    adminLlmReset: 'Reset LLM stats',
    adminUser: '🔎 User lookup',
    adminGrantPro: '⭐️ Grant Pro (30 days)',
    adminReset: '♻️ Reset user session',
    adminUserPrompt: 'Send the user ID to view (number).',
    adminGrantProPrompt: 'Send the user ID to grant Pro for 30 days (number).',
    adminResetPrompt: 'Send the user ID to reset session (number).',
    adminDone: '✅ Done.',
    adminInvalidUserId: '⚠️ Invalid user ID. Send only a number.',
    adminClose: '❌ Close',
    adminBroadcast: '📣 Broadcast',
    adminBroadcastPrompt: 'Send the message you want to broadcast to all users (as plain text).',
    adminBroadcastCancel: 'Cancel',
    adminBroadcastDone: '✅ Broadcast done. Sent: {sent}, failed: {failed}',
    adminTokensTitle: '🧾 Token usage (all users)',
    adminTokensNoData: 'No token usage data yet.',
    dailyLimitReached: '⚠️ Daily limit reached. Come back tomorrow or upgrade to Pro.',
    questionsLeftToday: '📊 Questions left today: {n}',
    stopped: '✅ Stopped. You can continue normally now.',
    statusTitle: 'ℹ️ Your status',
    statusPlanFree: 'Free',
    statusPlanPro: 'Pro (Premium)',
    statusExpires: 'expires: {date}',
    lowQuestionsWarning: '⚠️ Only {n} questions left today.',
    help:
      "ℹ️ How to use:\n\n" +
      "1) Send a lesson file (PDF/DOCX/PPTX)\n" +
      "2) Choose the number of questions\n" +
      "3) Choose difficulty\n" +
      "4) Answer polls one-by-one to continue\n\n" +
      "Tip: UI language only affects the bot messages. Questions follow the file's language.",
  },
  uz: {
    chooseLanguage: '🌐 Tilni tanlang:',
    uploadPrompt:
      '📤 Iltimos, faylni yuboring.\n\n' +
      'Cheklovlar:\n' +
      '- Maksimal fayl hajmi: 10MB\n' +
      '- Har bir test uchun maksimal matn: {maxChars} belgi (≈{maxWords} so‘z)\n' +
      '- Yaxshi natija uchun: {minWords}+ so‘z (≈{minChars}+ belgi) matn bo‘lsin',
    changeLanguageBtn: '🌐 Tilni o‘zgartirish',
    welcome:
      "👋 AI Quiz Bot-ga xush kelibsiz!\n\n" +
      "1️⃣ Dars faylini yuboring (PDF, DOCX, PPTX).\n" +
      "2️⃣ Savollar sonini tanlang.\n" +
      "3️⃣ Qiyinchilik darajasini tanlang.\n" +
      "4️⃣ Men siz uchun test tayyorlayman!\n\n" +
      '📤 Iltimos, faylni yuboring.',
    downloading: '⏳ Yuklab olinmoqda va matn ajratilmoqda...',
    invalidType: "❌ Noto'g'ri fayl turi. PDF, DOCX yoki PPTX yuboring.",
    invalidSize: '❌ Fayl juda katta. Maksimal hajm 10MB.',
    notEnoughText:
      "⚠️ Fayldan yetarli matn ajratib bo'lmadi.\n\n" +
      "Ko'proq o'qiladigan matnli fayl yuboring (tavsiya: {minWords}+ so‘z / {minChars}+ belgi).",
    textTooLong:
      "⚠️ Bu faylda juda ko'p matn bor, ishonchli ishlay olmaydi.\n\n" +
      "Iltimos, kichikroq fayl yuboring yoki bo'lib yuboring.\n" +
      "Maksimal ajratilgan matn: {maxTotalChars} belgi.",
    longTextNotice:
      "ℹ️ Faylingiz uzun. Savollar faqat {part}/{parts} qismdan olinadi.\n\n" +
      "Har bir test uchun limit: {maxChars} belgi (≈{maxWords} so‘z).\n" +
      "Pastdagi tugma orqali qismni o'zgartirishingiz mumkin.",
    choosePartBtn: '📄 Qism tanlash',
    choosePartTitle: '📄 Faylning qaysi qismini ishlatay?',
    selectedPart: '✅ Tanlandi: {part}/{parts} qism.',
    partPreviewTitle: '📄 {part}/{parts} qism',
    partPreviewHint: 'Ko‘rinish (birinchi satrlar):',
    partPrevBtn: '⬅️ Oldingi',
    partNextBtn: 'Keyingi ➡️',
    partUseBtn: '✅ Shu qismni tanlash',
    chooseQuestionType:
      '📝 Savol turini tanlang:\n\n' +
      '🗳 Poll (Variantli): A/B/C/D ni bosasiz.\n' +
      '⌨️ Ochiq (Yozib): javobni o‘zingiz yozasiz.\n' +
      '✅ True / False / NG: matnda bo‘lsa True/False, matnda yo‘q bo‘lsa NG tanlanadi.',
    questionTypePollBtn: '🗳 Poll (Variantli)',
    questionTypeOpenBtn: '⌨️ Ochiq (Javob yozish)',
    questionTypeTfngBtn: '✅ True / False / NG',
    selectedQuestionTypePoll: '✅ Tanlandi: Poll savollar (variantli).',
    selectedQuestionTypeOpen: '✅ Tanlandi: Ochiq savollar (javob yozasiz).',
    selectedQuestionTypeTfng: '✅ Tanlandi: True / False / NG.',
    howMany: '✅ Fayl tayyor! Nechta savol bo‘lsin?',
    chooseDifficulty: '🧠 Qiyinchilik darajasini tanlang:',
    analyzing: '🤖 Tahlil qilinmoqda va savollar yaratilmoqda... Biroz kuting.',
    insufficient: "⚠️ Matn yetarli emas. Boshqa fayl yuboring yoki ko'proq matnli fayl tanlang.",
    answerToContinue: '🎉 {n} ta savol tayyor! Keyingisi uchun javob bering.',
    finishedScore: '✅ Test tugadi! Natija: {score}/{total}',
    openAnswerPrompt: '✍️ Javobingizni yozing (matn).',
    openCorrect: '✅ To‘g‘ri!\n\n{explanation}',
    openWrong: '❌ Noto‘g‘ri.\n✅ To‘g‘ri javob: {answer}\n\n{explanation}',
    busy: '⏳ Iltimos kuting… Oldingi so‘rov hali ishlanmoqda.',
    noMoreUnique: '⚠️ Bu fayldan yana noyob savol chiqara olmadim. Yangi fayl yuboring yoki qiyinchilikni o‘zgartiring.',
    morePrompt: 'Keyingi amal?',
    moreBtn: "Yana savollar yaratish",
    newFileBtn: 'Yangi fayl yuborish',
    needLanguage: '🌐 Avval tilni tanlang.',
    sessionExpired: '⚠️ Sessiya tugagan. Iltimos, faylni qayta yuboring.',
    selectedCount: '✅ Tanlandi: {n} ta savol.',
    selectedDifficulty: '✅ Tanlandi: {difficulty} rejimi.',
    diff_easy: 'Oson',
    diff_exam: 'Imtihon',
    diff_hard: 'Qiyin',
    easyBtn: "🟢 Oson (Ta'riflar)",
    examBtn: '🟡 Imtihon (Tushunchalar)',
    hardBtn: '🔴 Qiyin (Amaliyot)',
    unauthorized: '❌ Ruxsat yo‘q.',
    adminPanel: '🛠 Admin panel',
    adminStats: '📊 Statistika',
    adminLlm: '🧠 LLM diagnostika',
    adminTokens: '🧾 Token sarfi',
    adminLlmReset: 'LLM statistikani tozalash',
    adminUser: '🔎 User maʼlumot',
    adminGrantPro: '⭐️ Pro berish (30 kun)',
    adminReset: '♻️ Sessiyani tozalash',
    adminUserPrompt: 'Ko‘rish uchun user ID yuboring (raqam).',
    adminGrantProPrompt: 'Pro berish uchun user ID yuboring (30 kun) (raqam).',
    adminResetPrompt: 'Sessiyani tozalash uchun user ID yuboring (raqam).',
    adminDone: '✅ Tayyor.',
    adminInvalidUserId: '⚠️ Noto‘g‘ri user ID. Faqat raqam yuboring.',
    adminClose: '❌ Yopish',
    adminBroadcast: '📣 Xabar yuborish',
    adminBroadcastPrompt: "Barcha foydalanuvchilarga yuboriladigan xabarni yuboring (oddiy matn).",
    adminBroadcastCancel: 'Bekor qilish',
    adminBroadcastDone: '✅ Xabar yuborildi. Yuborildi: {sent}, xatolik: {failed}',
    adminTokensTitle: '🧾 Token sarfi (barcha foydalanuvchilar)',
    adminTokensNoData: 'Hali token sarfi ma’lumoti yo‘q.',
    dailyLimitReached: '⚠️ Kunlik limit tugadi. Ertaga qaytib keling yoki Pro-ga o‘ting.',
    questionsLeftToday: '📊 Bugun qolgan savollar: {n}',
    stopped: '✅ To‘xtatildi. Endi odatdagidek davom etishingiz mumkin.',
    statusTitle: 'ℹ️ Sizning holatingiz',
    statusPlanFree: 'Free',
    statusPlanPro: 'Pro (Premium)',
    statusExpires: 'tugash vaqti: {date}',
    lowQuestionsWarning: '⚠️ Bugun atigi {n} ta savol qoldi.',
    help:
      "ℹ️ Foydalanish:\n\n" +
      "1) Dars faylini yuboring (PDF/DOCX/PPTX)\n" +
      "2) Savollar sonini tanlang\n" +
      "3) Qiyinchilikni tanlang\n" +
      "4) Keyingi savol uchun pollga javob bering\n\n" +
      "Eslatma: UI tili faqat bot xabarlariga ta'sir qiladi. Savollar fayl tilida bo'ladi.",
  },
  ru: {
    chooseLanguage: '🌐 Выберите язык:',
    uploadPrompt:
      '📤 Пожалуйста, отправьте файл.\n\n' +
      'Ограничения:\n' +
      '- Максимальный размер: 10MB\n' +
      '- Максимум текста на один тест: {maxChars} символов (≈{maxWords} слов)\n' +
      '- Для лучшего результата: {minWords}+ слов (≈{minChars}+ символов) читаемого текста',
    changeLanguageBtn: '🌐 Изменить язык',
    welcome:
      "👋 Добро пожаловать в AI Quiz Bot!\n\n" +
      "1️⃣ Отправьте файл урока (PDF, DOCX, PPTX).\n" +
      "2️⃣ Выберите количество вопросов.\n" +
      "3️⃣ Выберите уровень сложности.\n" +
      "4️⃣ Я сгенерирую тест для проверки знаний!\n\n" +
      '📤 Пожалуйста, отправьте файл.',
    downloading: '⏳ Скачивание и извлечение текста...',
    invalidType: '❌ Неверный тип файла. Отправьте PDF, DOCX или PPTX.',
    invalidSize: '❌ Файл слишком большой. Максимум 10MB.',
    notEnoughText:
      '⚠️ Не удалось извлечь достаточно текста.\n\n' +
      'Попробуйте файл с большим количеством читаемого текста (рекомендация: {minWords}+ слов / {minChars}+ символов).',
    textTooLong:
      '⚠️ В этом файле слишком много текста — обработать надёжно не получится.\n\n' +
      'Отправьте файл поменьше или разделите на части.\n' +
      'Максимум извлечённого текста: {maxTotalChars} символов.',
    longTextNotice:
      'ℹ️ Файл длинный. Вопросы будут генерироваться только из части {part}/{parts}.\n\n' +
      'Лимит на один тест: {maxChars} символов (≈{maxWords} слов).\n' +
      'Часть можно сменить кнопкой ниже.',
    choosePartBtn: '📄 Выбрать часть',
    choosePartTitle: '📄 Выберите часть файла:',
    selectedPart: '✅ Выбрана часть {part}/{parts}.',
    partPreviewTitle: '📄 Часть {part}/{parts}',
    partPreviewHint: 'Превью (первые строки):',
    partPrevBtn: '⬅️ Назад',
    partNextBtn: 'Далее ➡️',
    partUseBtn: '✅ Использовать эту часть',
    chooseQuestionType:
      '📝 Выберите тип вопросов:\n\n' +
      '🗳 Опрос (Варианты): нажимаете A/B/C/D.\n' +
      '⌨️ Открытый (Ввод): вводите ответ текстом.\n' +
      '✅ True / False / NG: True/False если утверждение есть в тексте; NG если в тексте этого нет.',
    questionTypePollBtn: '🗳 Опрос (Варианты)',
    questionTypeOpenBtn: '⌨️ Открытый (Ввод ответа)',
    questionTypeTfngBtn: '✅ True / False / NG',
    selectedQuestionTypePoll: '✅ Выбрано: Опросы (с вариантами).',
    selectedQuestionTypeOpen: '✅ Выбрано: Открытые вопросы (ввод ответа).',
    selectedQuestionTypeTfng: '✅ Выбрано: True / False / NG.',
    howMany: '✅ Файл обработан! Сколько вопросов хотите?',
    chooseDifficulty: '🧠 Выберите уровень сложности:',
    analyzing: '🤖 Анализ и генерация вопросов... Подождите немного.',
    insufficient: '⚠️ Не удалось сгенерировать вопросы по этому тексту. Попробуйте другой файл.',
    answerToContinue: '🎉 Сгенерировано вопросов: {n}. Ответьте, чтобы получить следующий.',
    finishedScore: '✅ Тест завершён! Ваш результат: {score}/{total}',
    openAnswerPrompt: '✍️ Введите ответ (текст).',
    openCorrect: '✅ Верно!\n\n{explanation}',
    openWrong: '❌ Неверно.\n✅ Правильный ответ: {answer}\n\n{explanation}',
    busy: '⏳ Пожалуйста подождите… Предыдущий запрос ещё обрабатывается.',
    noMoreUnique: '⚠️ Не удалось сгенерировать больше уникальных вопросов по этому файлу. Загрузите новый файл или измените сложность.',
    morePrompt: 'Что дальше?',
    moreBtn: 'Сгенерировать ещё вопросы',
    newFileBtn: 'Загрузить новый файл',
    needLanguage: '🌐 Сначала выберите язык.',
    sessionExpired: '⚠️ Сессия истекла. Пожалуйста, отправьте файл заново.',
    selectedCount: '✅ Выбрано: {n} вопросов.',
    selectedDifficulty: '✅ Выбрано: режим {difficulty}.',
    diff_easy: 'Лёгкий',
    diff_exam: 'Экзамен',
    diff_hard: 'Сложный',
    easyBtn: '🟢 Лёгкий (Определения)',
    examBtn: '🟡 Экзамен (Понятия)',
    hardBtn: '🔴 Сложный (Практика)',
    unauthorized: '❌ Нет доступа.',
    adminPanel: '🛠 Админ-панель',
    adminStats: '📊 Статистика',
    adminLlm: '🧠 Диагностика LLM',
    adminTokens: '🧾 Расход токенов',
    adminLlmReset: 'Сбросить LLM статистику',
    adminUser: '🔎 Инфо о пользователе',
    adminGrantPro: '⭐️ Выдать Pro (30 дней)',
    adminReset: '♻️ Сброс сессии',
    adminUserPrompt: 'Отправьте user ID для просмотра (число).',
    adminGrantProPrompt: 'Отправьте user ID чтобы выдать Pro на 30 дней (число).',
    adminResetPrompt: 'Отправьте user ID для сброса сессии (число).',
    adminDone: '✅ Готово.',
    adminInvalidUserId: '⚠️ Неверный user ID. Отправьте только число.',
    adminClose: '❌ Закрыть',
    adminBroadcast: '📣 Рассылка',
    adminBroadcastPrompt: 'Отправьте текст сообщения для рассылки всем пользователям.',
    adminBroadcastCancel: 'Отмена',
    adminBroadcastDone: '✅ Рассылка завершена. Отправлено: {sent}, ошибки: {failed}',
    adminTokensTitle: '🧾 Расход токенов (все пользователи)',
    adminTokensNoData: 'Данных по расходу токенов пока нет.',
    dailyLimitReached: '⚠️ Дневной лимит исчерпан. Возвращайтесь завтра или переходите на Pro.',
    questionsLeftToday: '📊 Вопросов осталось сегодня: {n}',
    stopped: '✅ Остановлено. Теперь вы можете продолжать как обычно.',
    statusTitle: 'ℹ️ Ваш статус',
    statusPlanFree: 'Free',
    statusPlanPro: 'Pro (Premium)',
    statusExpires: 'истекает: {date}',
    lowQuestionsWarning: '⚠️ Осталось всего {n} вопросов на сегодня.',
    help:
      "ℹ️ Инструкция:\n\n" +
      "1) Отправьте файл урока (PDF/DOCX/PPTX)\n" +
      "2) Выберите количество вопросов\n" +
      "3) Выберите сложность\n" +
      "4) Отвечайте на опросы по одному, чтобы продолжать\n\n" +
      "Примечание: язык UI влияет только на сообщения бота. Вопросы будут на языке файла.",
  },
};

const addTokenUsage = (
  session: UserSession | undefined,
  u: {
    provider: 'gemini' | 'deepseek' | 'groq';
    model: string;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  }
) => {
  if (!session) return;
  if (!session.tokenUsage) session.tokenUsage = {};
  if (!session.tokenUsage.byProvider) session.tokenUsage.byProvider = {};
  if (!session.tokenUsage.byModel) session.tokenUsage.byModel = {};

  const p = Number(u.promptTokens ?? 0) || 0;
  const c = Number(u.completionTokens ?? 0) || 0;
  const t = Number(u.totalTokens ?? (p + c)) || 0;

  session.tokenUsage.promptTokens = (session.tokenUsage.promptTokens ?? 0) + p;
  session.tokenUsage.completionTokens = (session.tokenUsage.completionTokens ?? 0) + c;
  session.tokenUsage.totalTokens = (session.tokenUsage.totalTokens ?? 0) + t;

  const prov = session.tokenUsage.byProvider[u.provider] || {};
  prov.promptTokens = (prov.promptTokens ?? 0) + p;
  prov.completionTokens = (prov.completionTokens ?? 0) + c;
  prov.totalTokens = (prov.totalTokens ?? 0) + t;
  session.tokenUsage.byProvider[u.provider] = prov;

  const key = `${u.provider}:${u.model}`;
  const mod = session.tokenUsage.byModel[key] || {};
  mod.promptTokens = (mod.promptTokens ?? 0) + p;
  mod.completionTokens = (mod.completionTokens ?? 0) + c;
  mod.totalTokens = (mod.totalTokens ?? 0) + t;
  session.tokenUsage.byModel[key] = mod;
};

const fmtNum = (n: any) => {
  const x = Number(n ?? 0) || 0;
  return x.toLocaleString('en-US');
};

const safeEditMessageText = async (ctx: any, text: string, extra?: any) => {
  try {
    await ctx.editMessageText(text, extra);
  } catch (e: any) {
    const msg = String(e?.response?.description ?? e?.message ?? '');
    const notModified = msg.toLowerCase().includes('message is not modified');
    if (notModified) return;
    try {
      await ctx.reply(text, extra);
    } catch {
      // ignore
    }
  }
};

const aggregateTokenUsage = (allSessions: Array<UserSession | undefined>) => {
  const out = {
    usersWithData: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    byProvider: {} as Record<string, { promptTokens: number; completionTokens: number; totalTokens: number }>,
    byModel: {} as Record<string, { promptTokens: number; completionTokens: number; totalTokens: number }>,
    byUser: {} as Record<string, { promptTokens: number; completionTokens: number; totalTokens: number }>,
  };

  for (const s of allSessions) {
    const tu = s?.tokenUsage;
    if (!tu) continue;
    const p = Number(tu.promptTokens ?? 0) || 0;
    const c = Number(tu.completionTokens ?? 0) || 0;
    const t = Number(tu.totalTokens ?? (p + c)) || 0;
    if (p + c + t <= 0) continue;
    out.usersWithData++;
    out.promptTokens += p;
    out.completionTokens += c;
    out.totalTokens += t;

    for (const [prov, v] of Object.entries(tu.byProvider ?? {})) {
      const cur = out.byProvider[prov] || { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
      cur.promptTokens += Number(v?.promptTokens ?? 0) || 0;
      cur.completionTokens += Number(v?.completionTokens ?? 0) || 0;
      cur.totalTokens += Number(v?.totalTokens ?? 0) || 0;
      out.byProvider[prov] = cur;
    }

    for (const [model, v] of Object.entries(tu.byModel ?? {})) {
      const cur = out.byModel[model] || { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
      cur.promptTokens += Number(v?.promptTokens ?? 0) || 0;
      cur.completionTokens += Number(v?.completionTokens ?? 0) || 0;
      cur.totalTokens += Number(v?.totalTokens ?? 0) || 0;
      out.byModel[model] = cur;
    }
  }

  return out;
};

const sendOpenQuestion = async (ctx: any, questionIndex: number, total: number, q: any) => {
  const session = ctx.session as UserSession | undefined;
  const lang: Language = (session?.language as Language) || 'en';
  const text = String(q?.question ?? '');
  await ctx.reply(`${questionIndex + 1}/${total}. ${text}`);
  await ctx.reply(t(lang, 'openAnswerPrompt'));
};

const t = (lang: Language, key: string, vars?: Record<string, string | number>): string => {
  const template = messages[lang]?.[key] ?? messages.en[key] ?? key;
  const limits = getTextLimitVars();
  const allVars: Record<string, string | number> = {
    ...limits,
    maxTotalChars: MAX_FILE_TEXT_CHARS,
    ...(vars || {}),
  };
  return template.replace(/\{(\w+)\}/g, (_, k) => String(allVars[k] ?? `{${k}}`));
};

const FREE_DAILY_QUESTIONS_LIMIT = 40;
const PRO_DAILY_QUESTIONS_LIMIT = 400;
const UZ_TZ_OFFSET_MS = 5 * 60 * 60 * 1000;

const PREMIUM_DURATION_DAYS = Math.max(1, parseInt(process.env.PREMIUM_DURATION_DAYS || '30', 10) || 30);
const PRO_WARN_3D_MS = 3 * 24 * 60 * 60 * 1000;
const PRO_WARN_1D_MS = 1 * 24 * 60 * 60 * 1000;

const forceIpv4 = (process.env.FORCE_IPV4 ?? '1') !== '0';
try {
  if (forceIpv4 && typeof (dns as any).setDefaultResultOrder === 'function') {
    (dns as any).setDefaultResultOrder('ipv4first');
  }
} catch {
  // ignore
}

const isPremiumActive = (session: UserSession | undefined, nowMs: number = Date.now()): boolean => {
  if (!session) return false;
  const until = Number((session as any).proUntil ?? 0) || 0;
  if (until > nowMs) return true;
  return Boolean(session.isPro) && !(session as any).proUntil;
};

const normalizePremiumState = (session: UserSession | undefined, nowMs: number = Date.now()) => {
  if (!session) return;
  const until = Number((session as any).proUntil ?? 0) || 0;
  if (until > 0 && until <= nowMs) {
    session.isPro = false;
  }
  if (until > nowMs) {
    session.isPro = true;
  }
};

const maybeNotifyProStatus = async (ctx: any) => {
  const session = ctx?.session as UserSession | undefined;
  const uid = (ctx?.from as any)?.id;
  const chatId = (ctx?.chat as any)?.id;
  if (!session || !uid || !chatId) return;
  if (uid === ADMIN_ID) return;

  const lang: Language = (session.language as Language) || 'en';
  const now = Date.now();
  const until = Number((session as any).proUntil ?? 0) || 0;
  if (!until) return;

  if (until <= now) {
    if (!session.proExpiredNotified) {
      session.proExpiredNotified = true;
      session.proWarned1d = false;
      session.proWarned3d = false;
      session.isPro = false;
      try {
        await ctx.telegram.sendMessage(
          chatId,
          lang === 'uz'
            ? `⚠️ Pro (Premium) muddati tugadi. Premiumdan foydalanishni davom ettirish uchun admin bilan bog'laning: ${ADMIN_CONTACT}`
            : lang === 'ru'
              ? `⚠️ Срок Pro (Premium) истёк. Чтобы продлить, напишите админу: ${ADMIN_CONTACT}`
              : `⚠️ Your Pro (Premium) has expired. To extend, please contact the admin: ${ADMIN_CONTACT}`
        );
      } catch {
        // ignore
      }
    }
    return;
  }

  const remaining = until - now;
  if (remaining <= PRO_WARN_1D_MS && !session.proWarned1d) {
    session.proWarned1d = true;
    try {
      await ctx.telegram.sendMessage(
        chatId,
        lang === 'uz'
          ? `⏳ Pro (Premium) 1 kun ichida tugaydi. Uzaytirish uchun admin bilan bog'laning: ${ADMIN_CONTACT}`
          : lang === 'ru'
            ? `⏳ Pro (Premium) закончится через 1 день. Чтобы продлить, напишите админу: ${ADMIN_CONTACT}`
            : `⏳ Your Pro (Premium) will end in 1 day. To extend, contact the admin: ${ADMIN_CONTACT}`
      );
    } catch {
      // ignore
    }
    return;
  }

  if (remaining <= PRO_WARN_3D_MS && !session.proWarned3d) {
    session.proWarned3d = true;
    try {
      await ctx.telegram.sendMessage(
        chatId,
        lang === 'uz'
          ? `⏳ Pro (Premium) 3 kun ichida tugaydi. Uzaytirish uchun admin bilan bog'laning: ${ADMIN_CONTACT}`
          : lang === 'ru'
            ? `⏳ Pro (Premium) закончится через 3 дня. Чтобы продлить, напишите админу: ${ADMIN_CONTACT}`
            : `⏳ Your Pro (Premium) will end in 3 days. To extend, contact the admin: ${ADMIN_CONTACT}`
      );
    } catch {
      // ignore
    }
  }
};

const getDayKeyUzbekistan = (nowMs: number = Date.now()): string => {
  const d = new Date(nowMs + UZ_TZ_OFFSET_MS);
  return d.toISOString().slice(0, 10);
};

const getDailyLimit = (session: UserSession | undefined): number => {
  return isPremiumActive(session) ? PRO_DAILY_QUESTIONS_LIMIT : FREE_DAILY_QUESTIONS_LIMIT;
};

const ensureDailyUsageState = (session: UserSession | undefined) => {
  if (!session) return;
  const key = getDayKeyUzbekistan();
  if (session.dailyUsageDayKey !== key) {
    session.dailyUsageDayKey = key;
    session.dailyQuestionsUsed = 0;
  }
  if (session.dailyQuestionsUsed === undefined || session.dailyQuestionsUsed === null) {
    session.dailyQuestionsUsed = 0;
  }
};

const getRemainingDailyQuestions = (session: UserSession | undefined): number => {
  if (!session) return 0;
  ensureDailyUsageState(session);
  const limit = getDailyLimit(session);
  const used = Number(session.dailyQuestionsUsed ?? 0) || 0;
  return Math.max(0, limit - used);
};

const LOW_QUOTA_THRESHOLDS = [10, 5, 1];

const maybeWarnLowQuota = async (
  session: UserSession | undefined,
  lang: Language,
  send: (text: string) => Promise<any>
) => {
  if (!session) return;
  const remaining = getRemainingDailyQuestions(session);
  if (!LOW_QUOTA_THRESHOLDS.includes(remaining)) return;
  if (session.lastLowQuotaWarnedRemaining === remaining) return;
  session.lastLowQuotaWarnedRemaining = remaining;
  await send(t(lang, 'lowQuestionsWarning', { n: remaining }));
};

const consumeDailyQuestions = (session: UserSession | undefined, n: number): boolean => {
  if (!session) return false;
  ensureDailyUsageState(session);
  const remaining = getRemainingDailyQuestions(session);
  const want = Math.max(0, Number(n) || 0);
  if (want <= 0) return true;
  if (remaining < want) return false;
  session.dailyQuestionsUsed = (Number(session.dailyQuestionsUsed ?? 0) || 0) + want;
  return true;
};

const difficultyLabel = (lang: Language, difficulty: Difficulty): string => {
  const key = `diff_${difficulty}`;
  return t(lang, key);
};

const detectFileLanguage = (text: string): Language => {
  const sample = (text ?? '').slice(0, 4000);
  let cyr = 0;
  let lat = 0;
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i);
    if ((code >= 0x0400 && code <= 0x04FF) || (code >= 0x0500 && code <= 0x052F)) cyr++;
    else if ((code >= 0x0041 && code <= 0x005A) || (code >= 0x0061 && code <= 0x007A)) lat++;
  }
  const lower = sample.toLowerCase();
  const uzScore =
    (lower.includes("o‘") || lower.includes("g‘") || lower.includes("o'") || lower.includes("g'")) ? 1 : 0;
  const uzCyrScore = /[қўғҳ]/.test(lower) ? 1 : 0;
  if (cyr > lat * 1.2) {
    if (uzCyrScore) return 'uz';
    return 'ru';
  }
  if (uzScore) return 'uz';
  return 'en';
};

const languageKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('🇺🇸 English', 'lang_en')],
    [Markup.button.callback('🇺🇿 Uzbek', 'lang_uz')],
    [Markup.button.callback('🇷🇺 Russian', 'lang_ru')],
  ]);

const questionTypeKeyboard = (lang: Language) =>
  Markup.inlineKeyboard([
    [Markup.button.callback(t(lang, 'questionTypePollBtn'), 'qtype_poll')],
    [Markup.button.callback(t(lang, 'questionTypeOpenBtn'), 'qtype_open')],
    [Markup.button.callback(t(lang, 'questionTypeTfngBtn'), 'qtype_tfng')],
  ]);

const choosePartButtonKeyboard = (lang: Language) =>
  Markup.inlineKeyboard([[Markup.button.callback(t(lang, 'choosePartBtn'), 'choose_part')]]);

const partNavKeyboard = (lang: Language, part: number, parts: number) => {
  const prevOk = part > 1;
  const nextOk = part < parts;
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(t(lang, 'partPrevBtn'), prevOk ? 'part_nav_prev' : 'part_nav_noop'),
      Markup.button.callback(t(lang, 'partUseBtn'), 'part_use'),
      Markup.button.callback(t(lang, 'partNextBtn'), nextOk ? 'part_nav_next' : 'part_nav_noop'),
    ],
  ]);
};

const getPartPreview = (text: string, windowIndex: number): string => {
  const { maxChars } = getTextLimitVars();
  const start = Math.max(0, windowIndex) * Math.max(1, maxChars);
  const chunk = text.slice(start, start + Math.max(1, maxChars));
  const preview = chunk.replace(/\s+/g, ' ').trim();
  return preview.length <= 420 ? preview : preview.slice(0, 420).trimEnd() + '…';
};

const renderPartPreviewMessage = (lang: Language, session: UserSession) => {
  const parts = Math.max(1, Number(session.fileWindowCount ?? 1) || 1);
  const idx = Math.max(0, Math.min(parts - 1, Number(session.fileWindowIndex ?? 0) || 0));
  const part = idx + 1;
  const preview = session.fileText ? getPartPreview(session.fileText, idx) : '';
  return (
    `${t(lang, 'partPreviewTitle', { part, parts })}\n\n` +
    `${t(lang, 'partPreviewHint')}\n` +
    `${preview || '-'}\n\n` +
    `${t(lang, 'longTextNotice', { part, parts })}`
  );
};

const partSelectionKeyboard = (lang: Language, parts: number) => {
  const maxVisible = 10;
  const rows: any[] = [];
  const visible = Math.min(parts, maxVisible);

  let currentRow: any[] = [];
  for (let i = 1; i <= visible; i++) {
    currentRow.push(Markup.button.callback(String(i), `part_${i}`));
    if (currentRow.length >= 4) {
      rows.push(currentRow);
      currentRow = [];
    }
  }

  if (parts > maxVisible) {
    currentRow.push(Markup.button.callback('Last', `part_${parts}`));
  }

  if (currentRow.length) rows.push(currentRow);
  return Markup.inlineKeyboard(rows);
};

const normalizeFreeText = (s: string): string => {
  return (s || '')
    .toLowerCase()
    .replace(/[\u2019’]/g, "'")
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
};

const normalizeNumberText = (s: string): string => {
  return (s || '')
    .toLowerCase()
    .replace(/[,\s]+/g, '')
    .replace(/[^0-9.\-]/g, '')
    .trim();
};

const tokenJaccard = (a: string, b: string): number => {
  const aTokens = new Set(normalizeFreeText(a).split(' ').filter(Boolean));
  const bTokens = new Set(normalizeFreeText(b).split(' ').filter(Boolean));
  if (aTokens.size === 0 || bTokens.size === 0) return 0;
  let inter = 0;
  for (const t of aTokens) if (bTokens.has(t)) inter++;
  const union = aTokens.size + bTokens.size - inter;
  return union <= 0 ? 0 : inter / union;
};

const isAnswerMatch = (userAnswerRaw: string, canonicalRaw: string, acceptableRaw: string[]): boolean => {
  const userNorm = normalizeFreeText(userAnswerRaw);
  const canonNorm = normalizeFreeText(canonicalRaw);
  if (!userNorm || !canonNorm) return false;

  if (userNorm === canonNorm) return true;
  for (const a of acceptableRaw) {
    const an = normalizeFreeText(a);
    if (an && userNorm === an) return true;
  }

  const userNum = normalizeNumberText(userAnswerRaw);
  const canonNum = normalizeNumberText(canonicalRaw);
  if (userNum && canonNum && userNum === canonNum) return true;

  for (const a of acceptableRaw) {
    const an = normalizeNumberText(a);
    if (an && userNum && userNum === an) return true;
  }

  if (canonNorm.length >= 4 && userNorm.includes(canonNorm)) return true;
  if (tokenJaccard(userNorm, canonNorm) >= 0.86) return true;

  for (const a of acceptableRaw) {
    const an = normalizeFreeText(a);
    if (!an) continue;
    if (an.length >= 4 && userNorm.includes(an)) return true;
    if (tokenJaccard(userNorm, an) >= 0.86) return true;
  }

  return false;
};

const isOpenQuestion = (q: any): q is { question: string; answer: string; acceptableAnswers?: string[]; explanation: string } => {
  return q && typeof q.question === 'string' && typeof q.answer === 'string' && typeof q.explanation === 'string';
};

const isPollQuestion = (q: any): q is { question: string; options: string[]; correctIndex: number; explanation: string } => {
  return (
    q &&
    typeof q.question === 'string' &&
    Array.isArray(q.options) &&
    typeof q.correctIndex === 'number' &&
    typeof q.explanation === 'string'
  );
};

const mainMenuKeyboard = (lang: Language) => {
  const rows: any[] = [];
  rows.push([Markup.button.text(t(lang, 'changeLanguageBtn'))]);
  return Markup.keyboard(rows).resize();
};

const isChangeLanguageText = (text: string): boolean => {
  const values = Object.values(messages) as Array<Record<string, string>>;
  return values.some(m => m.changeLanguageBtn === text);
};

const changeLanguageTriggers: string[] = (Object.values(messages) as Array<Record<string, string>>)
  .map(m => m.changeLanguageBtn)
  .filter((v): v is string => typeof v === 'string' && v.length > 0);

const toPollSafeText = (text: string | undefined, maxLen: number): string => {
  const value = (text ?? '').toString();
  if (value.length <= maxLen) return value;
  return value.substring(0, Math.max(0, maxLen - 1)).trimEnd();
};

const normalizeQuestionText = (text: string): string => {
  return (text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
};

const jaccardSimilarity = (a: string, b: string): number => {
  const aTokens = new Set(normalizeQuestionText(a).split(' ').filter(Boolean));
  const bTokens = new Set(normalizeQuestionText(b).split(' ').filter(Boolean));
  if (aTokens.size === 0 || bTokens.size === 0) return 0;
  let intersection = 0;
  for (const t of aTokens) {
    if (bTokens.has(t)) intersection++;
  }
  const union = aTokens.size + bTokens.size - intersection;
  return union <= 0 ? 0 : intersection / union;
};

const isNearDuplicateQuestion = (candidate: string, existing: string[]): boolean => {
  const candNorm = normalizeQuestionText(candidate);
  if (!candNorm) return true;
  for (const e of existing) {
    const eNorm = normalizeQuestionText(e);
    if (!eNorm) continue;
    if (candNorm === eNorm) return true;
    if (jaccardSimilarity(candNorm, eNorm) >= 0.82) return true;
  }
  return false;
};

const safeAnswerCbQuery = async (ctx: any) => {
  try {
    if (ctx?.state?.cbAcked) return;
    if (!ctx?.callbackQuery) return;
    await ctx.answerCbQuery();
    if (ctx?.state) ctx.state.cbAcked = true;
  } catch {
    // ignore
  }
};

// Simple in-memory session store (Map<UserId, UserSession>)
const sessions = new Map<number, UserSession>();
const knownUsers = new Set<number>();

const getOrCreateUserSessionById = async (userId: number): Promise<UserSession> => {
  if (!sessions.has(userId)) sessions.set(userId, {});
  knownUsers.add(userId);

  if (dbEnabled) {
    const fromDb = (await getSession(userId)) ?? undefined;
    if (fromDb) {
      sessions.set(userId, fromDb);
      return fromDb;
    }
  }

  return sessions.get(userId)!;
};

const saveUserSessionById = async (userId: number, session: UserSession): Promise<void> => {
  sessions.set(userId, session);
  knownUsers.add(userId);

  if (dbEnabled) {
    await setSession(userId, session);
    return;
  }
};

// Middleware to attach session
const sessionMiddleware = async (ctx: MyContext, next: () => Promise<void>) => {
  const anyCtx0 = ctx as any;
  if (anyCtx0.callbackQuery) {
    await safeAnswerCbQuery(anyCtx0);
  }

  // Use ctx.from to get user info, which works for both messages and callback queries
  // Fix: Cast ctx to any to access 'from' property which might be missing in strict Context types
  const anyCtx = ctx as any;
  const userFromUpdate = anyCtx.from;
  const pollAnswerUser = anyCtx.pollAnswer?.user;
  const user = userFromUpdate ?? pollAnswerUser;

  if (!user) {
    await next();
    return;
  }

  if (dbEnabled) {
    const fromDb = (await getSession(user.id)) ?? undefined;

    // Always keep an in-memory copy to allow poll progression even if DB goes down mid-quiz.
    if (fromDb) {
      sessions.set(user.id, fromDb);
    } else if (!sessions.has(user.id)) {
      sessions.set(user.id, {});
    }

    knownUsers.add(user.id);
    ctx.session = sessions.get(user.id);
    if (ctx.session) {
      ctx.session.lastSeenAt = Date.now();
      normalizePremiumState(ctx.session);
    }

    await maybeNotifyProStatus(ctx as any);

    await next();

    if (ctx.session) {
      sessions.set(user.id, ctx.session);
      // Only attempt to persist if DB is still enabled.
      if (dbEnabled) {
        await setSession(user.id, ctx.session);
      }
    }
    return;
  }

  knownUsers.add(user.id);
  if (!sessions.has(user.id)) {
    sessions.set(user.id, {});
  }
  ctx.session = sessions.get(user.id);
  if (ctx.session) {
    ctx.session.lastSeenAt = Date.now();
    normalizePremiumState(ctx.session);
  }

  await maybeNotifyProStatus(ctx as any);
  await next();
};

const proxyUrl = process.env.ALL_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
const agent = proxyUrl ? new ProxyAgent(proxyUrl) : new https.Agent({ keepAlive: true } as any);
const undiciDispatcher = proxyUrl ? new UndiciProxyAgent(proxyUrl) : undefined;
const bot = new Telegraf<MyContext>(
  config.TELEGRAM_BOT_TOKEN,
  agent ? ({ telegram: { agent } } as any) : undefined
);
bot.use(sessionMiddleware);

bot.on(message('text'), async (ctx: any, next: any) => {
  const session = ctx.session as UserSession | undefined;
  if (!session || !session.awaitingOpenAnswer) return next();
  if (!session.quizQuestions || session.currentQuestionIndex === undefined || session.totalQuestions === undefined) {
    session.awaitingOpenAnswer = false;
    return next();
  }

  const text = String((ctx.message as any)?.text ?? '');
  if (text.startsWith('/')) return next();

  const q = (session.quizQuestions as any[])[session.currentQuestionIndex];
  if (!isOpenQuestion(q)) {
    session.awaitingOpenAnswer = false;
    return next();
  }

  const lang: Language = (session.language as Language) || 'en';
  const acceptableRaw = Array.isArray(q.acceptableAnswers) ? q.acceptableAnswers.map(a => String(a)) : [];
  const isCorrect = isAnswerMatch(text, String(q.answer ?? ''), acceptableRaw);

  session.score = (session.score ?? 0) + (isCorrect ? 1 : 0);

  if (isCorrect) {
    await ctx.reply(t(lang, 'openCorrect', { explanation: String(q.explanation ?? '') }));
  } else {
    await ctx.reply(t(lang, 'openWrong', { answer: String(q.answer ?? ''), explanation: String(q.explanation ?? '') }));
  }

  const nextIndex = session.currentQuestionIndex + 1;
  session.currentQuestionIndex = nextIndex;

  if (nextIndex >= session.totalQuestions) {
    await ctx.reply(t(lang, 'finishedScore', { score: session.score ?? 0, total: session.totalQuestions }));
    const remaining = getRemainingDailyQuestions(session);
    await ctx.reply(
      t(lang, 'morePrompt'),
      Markup.inlineKeyboard([
        ...(Array.isArray(session.quizQuestions) && session.quizQuestions.length > session.totalQuestions && remaining > 0
          ? [[Markup.button.callback(t(lang, 'moreBtn'), 'more')]]
          : []),
        [Markup.button.callback(t(lang, 'newFileBtn'), 'newfile')],
      ])
    );
    if (!Array.isArray(session.quizQuestions) || session.quizQuestions.length <= session.totalQuestions) {
      session.quizQuestions = undefined;
      session.currentQuestionIndex = undefined;
      session.totalQuestions = undefined;
      session.isProcessing = false;
    }
    session.awaitingOpenAnswer = false;
    return;
  }

  const nextQ = (session.quizQuestions as any[])[nextIndex];
  if (!consumeDailyQuestions(session, 1)) {
    await ctx.reply(t(lang, 'dailyLimitReached'));
    session.awaitingOpenAnswer = false;
    return;
  }
  await maybeWarnLowQuota(session, lang, (text) => ctx.reply(text));
  await sendOpenQuestion(ctx, nextIndex, session.totalQuestions, nextQ);
});

const fetchWithRetry = async (url: string) => {
  const maxRetries = 3;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, {
        ...(undiciDispatcher ? ({ dispatcher: undiciDispatcher } as any) : {}),
        signal: (AbortSignal as any).timeout?.(30000),
      } as any);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      return res;
    } catch (e) {
      if (attempt >= maxRetries) throw e;
      const waitMs = 1500 * Math.pow(2, attempt);
      await new Promise(r => setTimeout(r, waitMs));
    }
  }
  throw new Error('Unexpected fetch retry loop exit');
};

const sendQuestionPoll = async (
  telegram: any,
  chatId: number,
  userId: number,
  questionIndex: number,
  q: { question: string; options: string[]; correctIndex: number; explanation: string }
) => {
  const safeQuestion = toPollSafeText(`${questionIndex + 1}. ${q.question}`, 299);
  const safeOptions = (q.options ?? []).slice(0, 10).map(o => toPollSafeText(o, 99));
  const safeExplanation = toPollSafeText(q.explanation, 120);

  const pollMessage = await telegram.sendPoll(chatId, safeQuestion, safeOptions, {
    is_anonymous: false,
    type: 'quiz',
    correct_option_id: q.correctIndex,
    explanation: safeExplanation,
  });

  savePoll(pollMessage.poll.id, {
    chatId,
    userId,
    questionIndex,
    correctIndex: q.correctIndex,
    explanation: q.explanation,
    question: q.question,
  });
};

// --- COMMANDS ---

bot.command('start', async (ctx: MyContext) => {
  if (!ctx.from) return;
  if (!ctx.session) {
    if (!dbEnabled) {
      if (!sessions.has(ctx.from.id)) sessions.set(ctx.from.id, {});
      ctx.session = sessions.get(ctx.from.id);
    } else {
      ctx.session = {};
    }
  }

  const lang = ctx.session?.language as Language | undefined;
  if (!lang) {
    await (ctx as any).reply(t('en', 'chooseLanguage'), languageKeyboard());
    return;
  }

  await (ctx as any).reply(t(lang, 'uploadPrompt'), mainMenuKeyboard(lang));
});

bot.command('help', (ctx: MyContext) => {
  const lang: Language | undefined = ctx.session?.language as Language | undefined;
  if (!lang) {
    return (ctx as any).reply(t('en', 'chooseLanguage'), languageKeyboard());
  }
  return (ctx as any).reply(t(lang, 'help'));
});

bot.command('status', async (ctx: MyContext) => {
  const userId = (ctx.from as any)?.id;
  if (!userId) return;

  const session = ctx.session as UserSession | undefined;
  const lang: Language = (session?.language as Language) || 'en';

  const proActive = isPremiumActive(session);
  const until = Number((session as any)?.proUntil ?? 0) || 0;
  const limit = proActive ? PRO_DAILY_QUESTIONS_LIMIT : FREE_DAILY_QUESTIONS_LIMIT;
  const remaining = getRemainingDailyQuestions(session);
  const used = Math.max(0, limit - remaining);

  const planLine = proActive ? t(lang, 'statusPlanPro') : t(lang, 'statusPlanFree');
  const expiresLine = proActive && until > Date.now() ? `\n${t(lang, 'statusExpires', { date: new Date(until).toISOString().slice(0, 10) })}` : '';

  const msg =
    `${t(lang, 'statusTitle')}\n\n` +
    `id: ${userId}\n` +
    `plan: ${planLine}${expiresLine}\n` +
    `today: ${used}/${limit}\n` +
    `${t(lang, 'questionsLeftToday', { n: remaining })}`;

  await (ctx as any).reply(msg);
});

bot.command('stop', async (ctx: MyContext) => {
  const session = ctx.session as UserSession | undefined;
  const lang: Language = (session?.language as Language) || 'en';
  if (!session) {
    await (ctx as any).reply(t(lang, 'stopped'));
    return;
  }

  session.adminAwaitingBroadcast = false;
  session.adminAwaitingReset = false;
  session.adminAwaitingUserInfo = false;
  session.adminAwaitingProGrant = false;

  session.awaitingOpenAnswer = false;
  session.awaitingPartSelection = false;
  session.isProcessing = false;
  session.processingStartedAt = undefined;

  await (ctx as any).reply(t(lang, 'stopped'), mainMenuKeyboard(lang));
});

bot.command('id', async (ctx: MyContext) => {
  const userId = (ctx.from as any)?.id;
  if (!userId) return;
  const lang: Language = (ctx.session?.language as Language) || 'en';
  const msg =
    lang === 'uz'
      ? `🆔 Sizning user ID: ${userId}\n\nPremium (Pro) uchun admin-ga shu raqamni yuboring: ${ADMIN_CONTACT}`
      : lang === 'ru'
        ? `🆔 Ваш user ID: ${userId}\n\nОтправьте этот номер админу для Premium (Pro): ${ADMIN_CONTACT}`
        : `🆔 Your user ID: ${userId}\n\nSend this number to the admin to get Premium (Pro): ${ADMIN_CONTACT}`;
  await (ctx as any).reply(msg);
});

bot.command('premium', async (ctx: MyContext) => {
  const lang: Language = (ctx.session?.language as Language) || 'en';
  const text =
    lang === 'uz'
      ? (
          `⭐️ Pro (Premium) reja\n\n` +
          `✅ Kuniga 400 ta savol (Free: 40)\n` +
          `💳 Narxi: 10 000 so'm / oy\n\n` +
          `☕️ Bir kofe narxiga… lekin bu safar kofe emas — o'zingizga sarmoya.\n` +
          `📚 Ko'proq savol = ko'proq amaliyot = tezroq natija.\n` +
          `🚀 Bugun boshlang — 1 oyda farqni sezasiz.\n\n` +
          `Pro olish uchun admin bilan bog'laning: @a_adham`
        )
      : lang === 'ru'
        ? (
            `⭐️ Pro (Premium) план\n\n` +
            `✅ 400 вопросов в день (Free: 40)\n` +
            `💳 Цена: 10 000 сум / месяц\n\n` +
            `☕️ Это как чашка кофе… но вместо кофе — инвестиция в себя и знания.\n` +
            `📚 Больше вопросов = больше практики = быстрее прогресс.\n` +
            `🚀 Начните сегодня — почувствуете разницу уже через месяц.\n\n` +
            `Чтобы подключить Pro, напишите админу: @a_adham`
          )
        : (
            `⭐️ Pro (Premium) plan\n\n` +
            `✅ 400 questions/day (Free: 40)\n` +
            `💳 Price: 10,000 UZS / month\n\n` +
            `☕️ About the price of a coffee… but this time you invest in yourself.\n` +
            `📚 More questions = more practice = faster progress.\n` +
            `🚀 Start today — feel the difference in a month.\n\n` +
            `To activate Pro, contact the admin: @a_adham`
          );

  await (ctx as any).reply(text);
});

bot.command('part', async (ctx: MyContext) => {
  const session = ctx.session as UserSession | undefined;
  const lang: Language = (session?.language as Language) || 'en';
  if (!session || !session.fileText) {
    return (ctx as any).reply(t(lang, 'sessionExpired'));
  }

  const parts = Math.max(1, Number(session.fileWindowCount ?? getFileWindowCount(session.fileText.length)) || 1);
  const raw = String((ctx as any).message?.text ?? '').trim();
  const match = raw.match(/^\/part\s+(\d{1,4})\s*$/i);
  if (!match) {
    session.fileWindowCount = parts;
    session.fileWindowIndex = Math.max(0, Math.min(parts - 1, Number(session.fileWindowIndex ?? 0) || 0));
    await (ctx as any).reply(renderPartPreviewMessage(lang, session), partNavKeyboard(lang, (Number(session.fileWindowIndex ?? 0) || 0) + 1, parts));
    return;
  }

  const n = Math.max(1, Math.min(parts, parseInt(match[1], 10)));
  session.fileWindowIndex = n - 1;
  session.fileWindowCount = parts;
  session.awaitingPartSelection = false;
  await (ctx as any).reply(t(lang, 'selectedPart', { part: n, parts }));
  await (ctx as any).reply(t(lang, 'chooseQuestionType'), questionTypeKeyboard(lang));
});

bot.action('part_nav_noop', async (ctx: any) => {
  await safeAnswerCbQuery(ctx);
});

bot.action('part_nav_prev', async (ctx: any) => {
  const session = ctx.session as UserSession | undefined;
  const lang: Language = (session?.language as Language) || 'en';
  if (!session || !session.fileText) {
    await safeAnswerCbQuery(ctx);
    return ctx.reply(t(lang, 'sessionExpired'));
  }
  const parts = Math.max(1, Number(session.fileWindowCount ?? getFileWindowCount(session.fileText.length)) || 1);
  session.fileWindowCount = parts;
  session.fileWindowIndex = Math.max(0, (Number(session.fileWindowIndex ?? 0) || 0) - 1);
  await safeAnswerCbQuery(ctx);
  const part = (Number(session.fileWindowIndex ?? 0) || 0) + 1;
  await safeEditMessageText(ctx, renderPartPreviewMessage(lang, session), partNavKeyboard(lang, part, parts));
});

bot.action('part_nav_next', async (ctx: any) => {
  const session = ctx.session as UserSession | undefined;
  const lang: Language = (session?.language as Language) || 'en';
  if (!session || !session.fileText) {
    await safeAnswerCbQuery(ctx);
    return ctx.reply(t(lang, 'sessionExpired'));
  }
  const parts = Math.max(1, Number(session.fileWindowCount ?? getFileWindowCount(session.fileText.length)) || 1);
  session.fileWindowCount = parts;
  session.fileWindowIndex = Math.min(parts - 1, (Number(session.fileWindowIndex ?? 0) || 0) + 1);
  await safeAnswerCbQuery(ctx);
  const part = (Number(session.fileWindowIndex ?? 0) || 0) + 1;
  await safeEditMessageText(ctx, renderPartPreviewMessage(lang, session), partNavKeyboard(lang, part, parts));
});

bot.action('part_use', async (ctx: any) => {
  const session = ctx.session as UserSession | undefined;
  const lang: Language = (session?.language as Language) || 'en';
  if (!session || !session.fileText) {
    await safeAnswerCbQuery(ctx);
    return ctx.reply(t(lang, 'sessionExpired'));
  }
  const parts = Math.max(1, Number(session.fileWindowCount ?? getFileWindowCount(session.fileText.length)) || 1);
  session.fileWindowCount = parts;
  const idx = Math.max(0, Math.min(parts - 1, Number(session.fileWindowIndex ?? 0) || 0));
  session.fileWindowIndex = idx;
  session.awaitingPartSelection = false;
  await safeAnswerCbQuery(ctx);
  await ctx.reply(t(lang, 'selectedPart', { part: idx + 1, parts }));
  await ctx.reply(t(lang, 'chooseQuestionType'), questionTypeKeyboard(lang));
});

bot.action('choose_part', async (ctx: any) => {
  const session = ctx.session as UserSession | undefined;
  const lang: Language = (session?.language as Language) || 'en';
  if (!session || !session.fileText) {
    await safeAnswerCbQuery(ctx);
    return ctx.reply(t(lang, 'sessionExpired'));
  }
  const parts = Math.max(1, Number(session.fileWindowCount ?? getFileWindowCount(session.fileText.length)) || 1);
  session.fileWindowCount = parts;
  await safeAnswerCbQuery(ctx);
  await ctx.reply(renderPartPreviewMessage(lang, session), partNavKeyboard(lang, (Number(session.fileWindowIndex ?? 0) || 0) + 1, parts));
});

bot.action(/part_(\d+)/, async (ctx: any) => {
  const session = ctx.session as UserSession | undefined;
  const lang: Language = (session?.language as Language) || 'en';
  if (!session || !session.fileText) {
    await safeAnswerCbQuery(ctx);
    return ctx.reply(t(lang, 'sessionExpired'));
  }
  const parts = Math.max(1, Number(session.fileWindowCount ?? getFileWindowCount(session.fileText.length)) || 1);
  const n = Math.max(1, Math.min(parts, parseInt(ctx.match[1], 10)));
  session.fileWindowIndex = n - 1;
  session.fileWindowCount = parts;
  session.awaitingPartSelection = false;
  await safeAnswerCbQuery(ctx);
  await ctx.reply(t(lang, 'selectedPart', { part: n, parts }));
  await ctx.reply(t(lang, 'chooseQuestionType'), questionTypeKeyboard(lang));
});

bot.hears(changeLanguageTriggers, async (ctx: any) => {
  const lang: Language = (ctx.session?.language as Language) || 'en';
  await ctx.reply(t(lang, 'chooseLanguage'), languageKeyboard());
});

bot.command('admin', async (ctx: MyContext) => {
  const userId = (ctx.from as any)?.id;
  const lang: Language = (ctx.session?.language as Language) || 'en';
  if (!userId || userId !== ADMIN_ID) {
    await ctx.reply(t(lang, 'unauthorized'));
    return;
  }

  await ctx.reply(
    t(lang, 'adminPanel'),
    Markup.inlineKeyboard([
      [Markup.button.callback(t(lang, 'adminStats'), 'admin_stats')],
      [Markup.button.callback(t(lang, 'adminLlm'), 'admin_llm')],
      [Markup.button.callback(t(lang, 'adminTokens'), 'admin_tokens')],
      [Markup.button.callback(t(lang, 'adminUser'), 'admin_user')],
      [Markup.button.callback(t(lang, 'adminGrantPro'), 'admin_grant_pro')],
      [Markup.button.callback(t(lang, 'adminReset'), 'admin_reset')],
      [Markup.button.callback(t(lang, 'adminBroadcast'), 'admin_broadcast')],
      [Markup.button.callback(t(lang, 'adminClose'), 'admin_close')],
    ])
  );
});

bot.action('admin_stats', async (ctx: any) => {
  const userId = (ctx.from as any)?.id;
  if (!userId || userId !== ADMIN_ID) {
    await safeAnswerCbQuery(ctx);
    return;
  }
  const lang: Language = (ctx.session?.language as Language) || 'en';

  const { startMs, endMs } = getUzbekistanTodayRange();

  let usersCount = knownUsers.size;
  let sessionsCount = sessions.size;
  let withFile = 0;
  let processing = 0;
  let premiumCount = 0;
  let freeCount = 0;
  let activeToday = 0;
  if (dbEnabled) {
    const stats = await getStats();
    usersCount = stats.users;
    sessionsCount = stats.users;
    withFile = stats.withFile;
    processing = stats.processing;

    const plan = await getPlanStats();
    premiumCount = plan.premium;
    freeCount = plan.free;

    activeToday = await getActiveUsersBetween(startMs, endMs);
  } else {
    for (const s of sessions.values()) {
      if (s.fileText) withFile++;
      if (s.isProcessing) processing++;
    }
    for (const s of sessions.values()) {
      if (isPremiumActive(s)) premiumCount++;
    }
    freeCount = Math.max(0, sessions.size - premiumCount);

    for (const s of sessions.values()) {
      const last = Number(s.lastSeenAt ?? 0) || 0;
      if (last >= startMs && last < endMs) activeToday++;
    }
  }

  await safeAnswerCbQuery(ctx);
  await safeEditMessageText(
    ctx,
    `${t(lang, 'adminPanel')}\n\n` +
      `users: ${usersCount}\n` +
      `activeToday: ${activeToday}\n` +
      `free: ${freeCount}\n` +
      `premium: ${premiumCount}\n` +
      `sessions: ${sessionsCount}\n` +
      `withFile: ${withFile}\n` +
      `processing: ${processing}`,
    Markup.inlineKeyboard([
      [Markup.button.callback(t(lang, 'adminStats'), 'admin_stats')],
      [Markup.button.callback(t(lang, 'adminLlm'), 'admin_llm')],
      [Markup.button.callback(t(lang, 'adminTokens'), 'admin_tokens')],
      [Markup.button.callback(t(lang, 'adminGrantPro'), 'admin_grant_pro')],
      [Markup.button.callback(t(lang, 'adminReset'), 'admin_reset')],
      [Markup.button.callback(t(lang, 'adminBroadcast'), 'admin_broadcast')],
      [Markup.button.callback(t(lang, 'adminClose'), 'admin_close')],
    ])
  );
});

bot.action('admin_llm', async (ctx: any) => {
  const userId = (ctx.from as any)?.id;
  if (!userId || userId !== ADMIN_ID) {
    await safeAnswerCbQuery(ctx);
    return;
  }
  const lang: Language = (ctx.session?.language as Language) || 'en';
  const s = getLlmStats();
  const keys = (process.env.GEMINI_API_KEYS || '').split(',').map(x => x.trim()).filter(Boolean).length;
  const deepseek = Boolean((process.env.DEEPSEEK_API_KEY || '').trim());
  const groq = Boolean((process.env.GROQ_API_KEY || '').trim());
  const conc = process.env.LLM_MAX_CONCURRENCY || '5';
  await safeAnswerCbQuery(ctx);
  await safeEditMessageText(
    ctx,
    `${t(lang, 'adminPanel')}\n\n` +
      `concurrency: ${conc}\n` +
      `geminiKeys: ${keys || (process.env.API_KEY || process.env.GEMINI_API_KEY ? 1 : 0)}\n` +
      `deepseekEnabled: ${deepseek ? 'yes' : 'no'}\n` +
      `groqEnabled: ${groq ? 'yes' : 'no'}\n\n` +
      `gemini attempts/success/fail: ${s.geminiAttempts}/${s.geminiSuccess}/${s.geminiFail}\n` +
      `deepseek attempts/success/fail: ${(s as any).deepseekAttempts ?? 0}/${(s as any).deepseekSuccess ?? 0}/${(s as any).deepseekFail ?? 0}\n` +
      `groq attempts/success/fail: ${s.groqAttempts}/${s.groqSuccess}/${s.groqFail}\n` +
      `last provider: ${s.lastProvider}\n` +
      `last model: ${s.lastModel}\n` +
      `last error: ${s.lastError || '-'}\n`,
    Markup.inlineKeyboard([
      [Markup.button.callback(t(lang, 'adminLlmReset'), 'admin_llm_reset')],
      [Markup.button.callback(t(lang, 'adminStats'), 'admin_stats')],
      [Markup.button.callback(t(lang, 'adminTokens'), 'admin_tokens')],
      [Markup.button.callback(t(lang, 'adminUser'), 'admin_user')],
      [Markup.button.callback(t(lang, 'adminClose'), 'admin_close')],
    ])
  );
});

bot.action('admin_tokens', async (ctx: any) => {
  const userId = (ctx.from as any)?.id;
  if (!userId || userId !== ADMIN_ID) {
    await safeAnswerCbQuery(ctx);
    return;
  }
  const lang: Language = (ctx.session?.language as Language) || 'en';

  let allSessions: Array<UserSession | undefined> = [];
  if (dbEnabled) {
    const ids = await listUserIds();
    for (const id of ids) {
      allSessions.push(await getSession(id));
    }
  } else {
    allSessions = Array.from(sessions.values());
  }

  const agg = aggregateTokenUsage(allSessions);
  if (agg.usersWithData <= 0) {
    await safeAnswerCbQuery(ctx);
    await safeEditMessageText(
      ctx,
      `${t(lang, 'adminTokensTitle')}\n\n${t(lang, 'adminTokensNoData')}`,
      Markup.inlineKeyboard([
        [Markup.button.callback(t(lang, 'adminStats'), 'admin_stats')],
        [Markup.button.callback(t(lang, 'adminLlm'), 'admin_llm')],
        [Markup.button.callback(t(lang, 'adminClose'), 'admin_close')],
      ])
    );
    return;
  }

  const byProvLines = Object.entries(agg.byProvider)
    .sort((a, b) => (b[1]?.totalTokens ?? 0) - (a[1]?.totalTokens ?? 0))
    .map(([k, v]) => `${k}: total=${fmtNum(v.totalTokens)} (p=${fmtNum(v.promptTokens)}, c=${fmtNum(v.completionTokens)})`);

  const byModelLines = Object.entries(agg.byModel)
    .sort((a, b) => (b[1]?.totalTokens ?? 0) - (a[1]?.totalTokens ?? 0))
    .slice(0, 12)
    .map(([k, v]) => `${k}: total=${fmtNum(v.totalTokens)} (p=${fmtNum(v.promptTokens)}, c=${fmtNum(v.completionTokens)})`);

  await safeAnswerCbQuery(ctx);
  await safeEditMessageText(
    ctx,
    `${t(lang, 'adminTokensTitle')}\n\n` +
      `usersWithData: ${agg.usersWithData}\n` +
      `totalTokens: ${fmtNum(agg.totalTokens)}\n` +
      `promptTokens: ${fmtNum(agg.promptTokens)}\n` +
      `completionTokens: ${fmtNum(agg.completionTokens)}\n\n` +
      `byProvider:\n${byProvLines.join('\n') || '-'}\n\n` +
      `byModel (top):\n${byModelLines.join('\n') || '-'}`,
    Markup.inlineKeyboard([
      [Markup.button.callback(t(lang, 'adminStats'), 'admin_stats')],
      [Markup.button.callback(t(lang, 'adminLlm'), 'admin_llm')],
      [Markup.button.callback(t(lang, 'adminClose'), 'admin_close')],
    ])
  );
});

bot.action('admin_user', async (ctx: any) => {
  const userId = (ctx.from as any)?.id;
  if (!userId || userId !== ADMIN_ID) {
    await safeAnswerCbQuery(ctx);
    return;
  }
  const lang: Language = (ctx.session?.language as Language) || 'en';
  if (ctx.session) {
    ctx.session.adminAwaitingUserInfo = true;
    ctx.session.adminAwaitingReset = false;
    ctx.session.adminAwaitingProGrant = false;
  }
  await safeAnswerCbQuery(ctx);
  await safeEditMessageText(ctx, t(lang, 'adminUserPrompt'));
});

bot.action('admin_llm_reset', async (ctx: any) => {
  const userId = (ctx.from as any)?.id;
  if (!userId || userId !== ADMIN_ID) {
    await safeAnswerCbQuery(ctx);
    return;
  }
  resetLlmStats();
  const lang: Language = (ctx.session?.language as Language) || 'en';
  await safeAnswerCbQuery(ctx);
  await safeEditMessageText(ctx, t(lang, 'adminDone'));
});

bot.action('admin_grant_pro', async (ctx: any) => {
  const userId = (ctx.from as any)?.id;
  if (!userId || userId !== ADMIN_ID) {
    await safeAnswerCbQuery(ctx);
    return;
  }
  const lang: Language = (ctx.session?.language as Language) || 'en';
  if (ctx.session) {
    ctx.session.adminAwaitingUserInfo = false;
    ctx.session.adminAwaitingReset = false;
    ctx.session.adminAwaitingProGrant = true;
  }
  await safeAnswerCbQuery(ctx);
  await safeEditMessageText(ctx, t(lang, 'adminGrantProPrompt'));
});

bot.action('admin_reset', async (ctx: any) => {
  const userId = (ctx.from as any)?.id;
  if (!userId || userId !== ADMIN_ID) {
    await safeAnswerCbQuery(ctx);
    return;
  }
  const lang: Language = (ctx.session?.language as Language) || 'en';
  if (ctx.session) {
    ctx.session.adminAwaitingReset = true;
    ctx.session.adminAwaitingUserInfo = false;
    ctx.session.adminAwaitingProGrant = false;
  }
  await safeAnswerCbQuery(ctx);
  await safeEditMessageText(ctx, t(lang, 'adminResetPrompt'));
});

bot.action('admin_broadcast', async (ctx: any) => {
  const userId = (ctx.from as any)?.id;
  if (!userId || userId !== ADMIN_ID) {
    await safeAnswerCbQuery(ctx);
    return;
  }
  const lang: Language = (ctx.session?.language as Language) || 'en';
  if (ctx.session) {
    ctx.session.adminAwaitingBroadcast = true;
  }
  await safeAnswerCbQuery(ctx);
  await safeEditMessageText(
    ctx,
    t(lang, 'adminBroadcastPrompt'),
    Markup.inlineKeyboard([[Markup.button.callback(t(lang, 'adminBroadcastCancel'), 'admin_broadcast_cancel')]])
  );
});

bot.action('admin_broadcast_cancel', async (ctx: any) => {
  const userId = (ctx.from as any)?.id;
  if (!userId || userId !== ADMIN_ID) {
    await safeAnswerCbQuery(ctx);
    return;
  }
  if (ctx.session) {
    ctx.session.adminAwaitingBroadcast = false;
  }
  const lang: Language = (ctx.session?.language as Language) || 'en';
  await safeAnswerCbQuery(ctx);
  await safeEditMessageText(
    ctx,
    t(lang, 'adminPanel'),
    Markup.inlineKeyboard([
      [Markup.button.callback(t(lang, 'adminStats'), 'admin_stats')],
      [Markup.button.callback(t(lang, 'adminBroadcast'), 'admin_broadcast')],
      [Markup.button.callback(t(lang, 'adminClose'), 'admin_close')],
    ])
  );
});

bot.on('message' as any, async (ctx: any, next: any) => {
  const userId = (ctx.from as any)?.id;
  if (!userId || userId !== ADMIN_ID) {
    return next();
  }

  const lang: Language = (ctx.session?.language as Language) || 'en';
  const text = String((ctx.message as any)?.text ?? '').trim();

  if (ctx.session?.adminAwaitingUserInfo || ctx.session?.adminAwaitingProGrant || ctx.session?.adminAwaitingReset) {
    const targetId = Number(text);
    if (!Number.isFinite(targetId) || targetId <= 0) {
      await ctx.reply(t(lang, 'adminInvalidUserId'));
      return;
    }
    if (ctx.session.adminAwaitingUserInfo) {
      const s = await getOrCreateUserSessionById(targetId);
      const last = s.lastSeenAt ? new Date(s.lastSeenAt).toISOString() : '-';

      const now = Date.now();
      const until = Number((s as any).proUntil ?? 0) || 0;
      const proLine = until > now ? `\nproUntil: ${new Date(until).toISOString()}` : until ? `\nproUntil: ${new Date(until).toISOString()} (expired)` : '';

      const tu = s.tokenUsage;
      const tuLine = tu
        ? `\n` +
          `tokens.total: ${fmtNum(tu.totalTokens)} (p=${fmtNum(tu.promptTokens)}, c=${fmtNum(tu.completionTokens)})`
        : '';
      await ctx.reply(
        `userId: ${targetId}\n` +
          `lang: ${s.language || '-'}\n` +
          `hasFile: ${s.fileText ? 'yes' : 'no'}\n` +
          `questionType: ${s.questionType || '-'}\n` +
          `processing: ${s.isProcessing ? 'yes' : 'no'}\n` +
          `lastSeenAt: ${last}` +
          proLine +
          tuLine
      );
      ctx.session.adminAwaitingUserInfo = false;
      return;
    }
    if (ctx.session.adminAwaitingProGrant) {
      const s = await getOrCreateUserSessionById(targetId);
      const now = Date.now();
      const curUntil = Number((s as any).proUntil ?? 0) || 0;
      const base = Math.max(now, curUntil);
      const newUntil = base + PREMIUM_DURATION_DAYS * 24 * 60 * 60 * 1000;
      (s as any).proUntil = newUntil;
      s.isPro = true;
      s.proWarned3d = false;
      s.proWarned1d = false;
      s.proExpiredNotified = false;
      await saveUserSessionById(targetId, s);
      ctx.session.adminAwaitingProGrant = false;
      await ctx.reply(`${t(lang, 'adminDone')}\nproUntil: ${new Date(newUntil).toISOString()}`);
      return;
    }
    if (ctx.session.adminAwaitingReset) {
      const s = await getOrCreateUserSessionById(targetId);
      const newSession: UserSession = {};
      await saveUserSessionById(targetId, newSession);
      ctx.session.adminAwaitingReset = false;
      await ctx.reply(t(lang, 'adminDone'));
      return;
    }
  }

  if (!ctx.session?.adminAwaitingBroadcast) {
    return next();
  }

  const fromChatId = (ctx.chat as any)?.id;
  const messageId = (ctx.message as any)?.message_id;
  if (!fromChatId || !messageId) {
    return next();
  }

  if (ctx.session) {
    ctx.session.adminAwaitingBroadcast = false;
  }

  let sent = 0;
  let failed = 0;
  const recipients = dbEnabled ? await listUserIds() : Array.from(knownUsers);
  for (const uid of recipients) {
    if (uid === ADMIN_ID) continue;
    try {
      await ctx.telegram.copyMessage(uid, fromChatId, messageId);
      sent++;
    } catch {
      failed++;
    }
  }

  await ctx.reply(t(lang, 'adminBroadcastDone', { sent, failed }));
  return;
});

bot.action('admin_close', async (ctx: any) => {
  const userId = (ctx.from as any)?.id;
  if (!userId || userId !== ADMIN_ID) {
    await safeAnswerCbQuery(ctx);
    return;
  }
  await safeAnswerCbQuery(ctx);
  await safeEditMessageText(ctx, 'OK');
});

bot.action(/lang_(en|uz|ru)/, async (ctx: any) => {
  const lang = ctx.match[1] as Language;
  if (ctx.session) {
    ctx.session.language = lang;
  }
  await safeAnswerCbQuery(ctx);

  await safeEditMessageText(ctx, t(lang, 'uploadPrompt'));
  await ctx.reply(t(lang, 'uploadPrompt'), mainMenuKeyboard(lang));
});

// --- FILE HANDLER ---

bot.on(message('document'), async (ctx: MyContext) => {
  const msg = ctx.message;
  if (!msg || !("document" in msg)) {
    return;
  }

  const adminUserId = (ctx.from as any)?.id;
  if (adminUserId === ADMIN_ID && ctx.session?.adminAwaitingBroadcast) {
    return;
  }

  const doc = (msg as any).document;
  const mimeType = doc.mime_type;
  const fileSize = doc.file_size;

  const lang: Language = (ctx.session?.language as Language) || 'en';

  if (!ctx.session?.language) {
    await ctx.reply(t(lang, 'needLanguage'), languageKeyboard());
    return;
  }

  if (!isValidFileType(mimeType)) {
    return ctx.reply(t(lang, 'invalidType'));
  }

  if (!isValidFileSize(fileSize)) {
    return ctx.reply(t(lang, 'invalidSize'));
  }

  try {
    await ctx.reply(t(lang, 'downloading'));
    
    // Get file link
    const fileLink = await ctx.telegram.getFileLink(doc.file_id);
    
    // Download file
    const response = await fetchWithRetry(fileLink.toString());
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Extract text
    const text = await parseFileContent({
      buffer,
      mimeType: mimeType || 'text/plain',
      originalName: doc.file_name
    });

    if (!text || text.trim().length < 50) {
      return ctx.reply(t(lang, 'notEnoughText'));
    }

    if (text.length > MAX_FILE_TEXT_CHARS) {
      return ctx.reply(t(lang, 'textTooLong'));
    }

    const parts = getFileWindowCount(text.length);

    // Store in session
    if (ctx.session) {
      ctx.session.fileText = text;
      ctx.session.fileLanguage = detectFileLanguage(text);
      ctx.session.fileWindowCount = parts;
      ctx.session.fileWindowIndex = 0;
      ctx.session.awaitingPartSelection = parts > 1;
      ctx.session.askedQuestionTexts = [];
      ctx.session.generationRound = 0;
      ctx.session.questionType = undefined;
      ctx.session.awaitingOpenAnswer = false;
    }

    if (parts > 1) {
      if (ctx.session) {
        await ctx.reply(renderPartPreviewMessage(lang, ctx.session), partNavKeyboard(lang, 1, parts));
      } else {
        await ctx.reply(t(lang, 'choosePartTitle'), partSelectionKeyboard(lang, parts));
      }
      return;
    }

    ctx.reply(t(lang, 'chooseQuestionType'), questionTypeKeyboard(lang));

  } catch (error) {
    handleError(ctx, error, "Failed to process file");
  }
});

bot.action('qtype_poll', async (ctx: any) => {
  const session = ctx.session as UserSession | undefined;
  const lang: Language = (session?.language as Language) || 'en';
  if (!session || !session.fileText) {
    await safeAnswerCbQuery(ctx);
    return ctx.reply(t(lang, 'sessionExpired'));
  }
  if (session.awaitingPartSelection) {
    const parts = Math.max(1, Number(session.fileWindowCount ?? getFileWindowCount(session.fileText.length)) || 1);
    session.fileWindowCount = parts;
    await safeAnswerCbQuery(ctx);
    await ctx.reply(renderPartPreviewMessage(lang, session), partNavKeyboard(lang, (Number(session.fileWindowIndex ?? 0) || 0) + 1, parts));
    return;
  }
  session.questionType = 'poll';
  session.awaitingOpenAnswer = false;
  await safeAnswerCbQuery(ctx);
  await safeEditMessageText(ctx, t(lang, 'selectedQuestionTypePoll'));
  await ctx.reply(
    t(lang, 'howMany'),
    Markup.inlineKeyboard([
      Markup.button.callback('3', 'count_3'),
      Markup.button.callback('5', 'count_5'),
      Markup.button.callback('10', 'count_10'),
    ])
  );
});

bot.action('qtype_open', async (ctx: any) => {
  const session = ctx.session as UserSession | undefined;
  const lang: Language = (session?.language as Language) || 'en';
  if (!session || !session.fileText) {
    await safeAnswerCbQuery(ctx);
    return ctx.reply(t(lang, 'sessionExpired'));
  }
  if (session.awaitingPartSelection) {
    const parts = Math.max(1, Number(session.fileWindowCount ?? getFileWindowCount(session.fileText.length)) || 1);
    session.fileWindowCount = parts;
    await safeAnswerCbQuery(ctx);
    await ctx.reply(renderPartPreviewMessage(lang, session), partNavKeyboard(lang, (Number(session.fileWindowIndex ?? 0) || 0) + 1, parts));
    return;
  }
  session.questionType = 'open';
  session.awaitingOpenAnswer = false;
  await safeAnswerCbQuery(ctx);
  await safeEditMessageText(ctx, t(lang, 'selectedQuestionTypeOpen'));
  await ctx.reply(
    t(lang, 'howMany'),
    Markup.inlineKeyboard([
      Markup.button.callback('3', 'count_3'),
      Markup.button.callback('5', 'count_5'),
      Markup.button.callback('10', 'count_10'),
    ])
  );
});

bot.action('qtype_tfng', async (ctx: any) => {
  const session = ctx.session as UserSession | undefined;
  const lang: Language = (session?.language as Language) || 'en';
  if (!session || !session.fileText) {
    await safeAnswerCbQuery(ctx);
    return ctx.reply(t(lang, 'sessionExpired'));
  }
  if (session.awaitingPartSelection) {
    const parts = Math.max(1, Number(session.fileWindowCount ?? getFileWindowCount(session.fileText.length)) || 1);
    session.fileWindowCount = parts;
    await safeAnswerCbQuery(ctx);
    await ctx.reply(renderPartPreviewMessage(lang, session), partNavKeyboard(lang, (Number(session.fileWindowIndex ?? 0) || 0) + 1, parts));
    return;
  }
  session.questionType = 'tfng';
  session.awaitingOpenAnswer = false;
  await safeAnswerCbQuery(ctx);
  await safeEditMessageText(ctx, t(lang, 'selectedQuestionTypeTfng'));
  await ctx.reply(
    t(lang, 'howMany'),
    Markup.inlineKeyboard([
      Markup.button.callback('3', 'count_3'),
      Markup.button.callback('5', 'count_5'),
      Markup.button.callback('10', 'count_10'),
    ])
  );
});

// --- ACTIONS (Question Count) ---

bot.action(/count_(\d+)/, async (ctx: any) => {
  if (!ctx.session || !ctx.session.fileText) {
    const fallbackLang: Language = (ctx.session?.language as Language) || 'en';
    return ctx.reply(t(fallbackLang, 'sessionExpired'));
  }

  if (!ctx.session.questionType) {
    const fallbackLang: Language = (ctx.session?.language as Language) || 'en';
    await safeAnswerCbQuery(ctx);
    await ctx.reply(t(fallbackLang, 'chooseQuestionType'), questionTypeKeyboard(fallbackLang));
    return;
  }

  const lang: Language = (ctx.session.language as Language) || 'en';

  const remainingBefore = getRemainingDailyQuestions(ctx.session);
  if (remainingBefore <= 0) {
    await safeAnswerCbQuery(ctx);
    await ctx.reply(t(lang, 'dailyLimitReached'));
    return;
  }

  if (ctx.session.isProcessing && ctx.session.processingStartedAt && Date.now() - ctx.session.processingStartedAt < 60_000) {
    await safeAnswerCbQuery(ctx);
    return ctx.reply(t(lang, 'busy'));
  }

  const count = parseInt(ctx.match[1], 10);
  ctx.session.questionCount = count;

  await safeAnswerCbQuery(ctx);
  await safeEditMessageText(ctx, t(lang, 'selectedCount', { n: count }));
  
  await ctx.reply(t(lang, 'chooseDifficulty'), Markup.inlineKeyboard([
    [Markup.button.callback(t(lang, 'easyBtn'), 'diff_easy')],
    [Markup.button.callback(t(lang, 'examBtn'), 'diff_exam')],
    [Markup.button.callback(t(lang, 'hardBtn'), 'diff_hard')],
  ]));
});

// --- ACTIONS (Difficulty & Generation) ---

bot.action(/diff_(.+)/, async (ctx: any) => {
  if (!ctx.session || !ctx.session.fileText || !ctx.session.questionCount) {
    const fallbackLang: Language = (ctx.session?.language as Language) || 'en';
    return ctx.reply(t(fallbackLang, 'sessionExpired'));
  }

  const lang: Language = (ctx.session.language as Language) || 'en';

  if (ctx.session.isProcessing && ctx.session.processingStartedAt && Date.now() - ctx.session.processingStartedAt < 60_000) {
    await safeAnswerCbQuery(ctx);
    return ctx.reply(t(lang, 'busy'));
  }

  const difficulty = ctx.match[1] as Difficulty;
  ctx.session.difficulty = difficulty;
  ctx.session.isProcessing = true;
  ctx.session.processingStartedAt = Date.now();

  await safeAnswerCbQuery(ctx);
  await safeEditMessageText(ctx, t(lang, 'selectedDifficulty', { difficulty: difficultyLabel(lang, difficulty) }));
  const processingMsg = await ctx.reply(t(lang, 'analyzing'));

  try {
    const quizLang: Language = (ctx.session.fileLanguage as Language) || 'en';
    const baseAvoid = (ctx.session.askedQuestionTexts ?? []).slice();
    const requestedCount = ctx.session.questionCount;
    const prefetchCount = Math.max(1, requestedCount * 3);
    const qType: QuestionType = (ctx.session.questionType as QuestionType) || 'poll';
    const roundBase = Number(ctx.session.generationRound ?? 0);
    ctx.session.generationRound = roundBase + 1;
    const windowIndex = Number(ctx.session.fileWindowIndex ?? 0) || 0;
    const quiz1 = await generateQuiz(
      ctx.session.fileText,
      prefetchCount,
      difficulty,
      quizLang,
      baseAvoid,
      windowIndex,
      qType,
      (u) => addTokenUsage(ctx.session, u)
    );

    const accepted: any[] = [];
    const seen = new Set<string>();
    for (const q of quiz1.questions ?? []) {
      const qText = String(q?.question ?? '');
      const norm = normalizeQuestionText(qText);
      if (!norm || seen.has(norm)) continue;
      if (isNearDuplicateQuestion(qText, baseAvoid)) continue;
      seen.add(norm);
      accepted.push(q);
    }

    // If the model returned repeats/paraphrases, do one extra attempt to top up.
    // Only top up if we can't even fill the FIRST page.
    if (accepted.length < requestedCount) {
      const remaining = requestedCount - accepted.length;
      const avoid2 = baseAvoid.concat(accepted.map(q => String(q?.question ?? '')));
      const round2 = Number(ctx.session.generationRound ?? (roundBase + 1));
      ctx.session.generationRound = round2 + 1;
      const quiz2 = await generateQuiz(
        ctx.session.fileText,
        remaining,
        difficulty,
        quizLang,
        avoid2,
        windowIndex,
        qType,
        (u) => addTokenUsage(ctx.session, u)
      );
      for (const q of quiz2.questions ?? []) {
        const qText = String(q?.question ?? '');
        const norm = normalizeQuestionText(qText);
        if (!norm || seen.has(norm)) continue;
        if (isNearDuplicateQuestion(qText, avoid2)) continue;
        seen.add(norm);
        accepted.push(q);
        if (accepted.length >= requestedCount) break;
      }
    }

    // Prefetch pool: cap to prefetchCount to keep session size predictable.
    const quiz = { questions: accepted.slice(0, prefetchCount) };

    // Fix: Explicitly access chat ID via cast to avoid "Property 'id' does not exist on type 'unknown'"
    const chatId = (ctx.chat as any).id;
    await ctx.telegram.deleteMessage(chatId, processingMsg.message_id);

    if (quiz.questions.length === 0) {
      ctx.session.isProcessing = false;
      ctx.session.processingStartedAt = undefined;
      return ctx.reply(t(lang, 'noMoreUnique'));
    }

    ctx.session.quizQuestions = quiz.questions;
    // Unlock only the first page; "Generate more" will unlock next pages without LLM calls.
    const remainingQuota = getRemainingDailyQuestions(ctx.session);
    ctx.session.totalQuestions = Math.min(requestedCount, quiz.questions.length, remainingQuota);
    ctx.session.currentQuestionIndex = 0;
    ctx.session.score = 0;

    ctx.session.askedQuestionTexts = (ctx.session.askedQuestionTexts ?? []).concat(
      quiz.questions.map(q => String(q?.question ?? '')).filter(Boolean)
    );

    if (qType === 'open') {
      ctx.session.awaitingOpenAnswer = true;
      await ctx.reply(t(lang, 'answerToContinue', { n: ctx.session.totalQuestions }));
      await ctx.reply(t(lang, 'questionsLeftToday', { n: getRemainingDailyQuestions(ctx.session) }));
      if (!consumeDailyQuestions(ctx.session, 1)) {
        ctx.session.awaitingOpenAnswer = false;
        await ctx.reply(t(lang, 'dailyLimitReached'));
        return;
      }
      await maybeWarnLowQuota(ctx.session, lang, (text) => ctx.reply(text));
      await sendOpenQuestion(ctx, 0, quiz.questions.length, quiz.questions[0]);
    } else {
      await ctx.reply(t(lang, 'answerToContinue', { n: ctx.session.totalQuestions }));
      await ctx.reply(t(lang, 'questionsLeftToday', { n: getRemainingDailyQuestions(ctx.session) }));

      const userId = (ctx.from as any)?.id;
      if (!userId) {
        return ctx.reply("⚠️ Could not identify user. Please try again.");
      }

      if (!consumeDailyQuestions(ctx.session, 1)) {
        await ctx.reply(t(lang, 'dailyLimitReached'));
        return;
      }
      await maybeWarnLowQuota(ctx.session, lang, (text) => ctx.reply(text));
      await sendQuestionPoll(ctx.telegram, chatId, userId, 0, quiz.questions[0] as any);
    }

    ctx.session.isProcessing = false;
    ctx.session.processingStartedAt = undefined;

  } catch (error) {
    handleError(ctx, error, "Failed to generate quiz");
    ctx.session.isProcessing = false;
    ctx.session.processingStartedAt = undefined;
  }
});

// --- POLL ANSWER HANDLER ---
// Note: Since we used native 'explanation' in sendPoll, the user sees the explanation 
// immediately after answering wrong/right in the UI. 
// However, to strictly satisfy "The bot replies with...", we can listen here.
// But native UI is much better for users (less spam).
// If we MUST send a text reply:

// Fix: Cast 'poll_answer' to any to avoid overload mismatch
bot.on('poll_answer' as any, async (ctx: any) => {
  // Fix: Cast ctx to any to access pollAnswer safely
  const answer = (ctx as any).pollAnswer;
  const pollId = answer.poll_id;
  const metadata = dbEnabled ? await getPollAsync(pollId) : getPoll(pollId);

  // If we don't have metadata (expired or restarted), skip
  if (!metadata) return;

  const userId = answer.user?.id;
  if (!userId || userId !== metadata.userId) return;

  const session = (ctx.session as UserSession | undefined) ?? undefined;
  if (!session || !session.quizQuestions || session.currentQuestionIndex === undefined || session.totalQuestions === undefined) return;

  const selectedOption = Array.isArray(answer.option_ids) ? answer.option_ids[0] : undefined;
  const isCorrect = selectedOption === metadata.correctIndex;
  session.score = (session.score ?? 0) + (isCorrect ? 1 : 0);

  const nextIndex = metadata.questionIndex + 1;
  session.currentQuestionIndex = nextIndex;

  if (nextIndex >= session.totalQuestions) {
    const lang: Language = (session.language as Language) || 'en';
    await ctx.telegram.sendMessage(
      metadata.chatId,
      t(lang, 'finishedScore', { score: session.score ?? 0, total: session.totalQuestions })
    );

    const remaining = getRemainingDailyQuestions(session);

    await ctx.telegram.sendMessage(
      metadata.chatId,
      t(lang, 'morePrompt'),
      Markup.inlineKeyboard([
        ...(Array.isArray(session.quizQuestions) && session.quizQuestions.length > session.totalQuestions && remaining > 0
          ? [[Markup.button.callback(t(lang, 'moreBtn'), 'more')]]
          : []),
        [Markup.button.callback(t(lang, 'newFileBtn'), 'newfile')],
      ])
    );

    // Only clear state when we have no more prefetched questions.
    if (!Array.isArray(session.quizQuestions) || session.quizQuestions.length <= session.totalQuestions) {
      session.quizQuestions = undefined;
      session.currentQuestionIndex = undefined;
      session.totalQuestions = undefined;
      session.isProcessing = false;
    }
    return;
  }

  const nextQ = session.quizQuestions[nextIndex];
  if (!isPollQuestion(nextQ)) {
    return;
  }

  if (!consumeDailyQuestions(session, 1)) {
    await ctx.telegram.sendMessage(metadata.chatId, t((session.language as Language) || 'en', 'dailyLimitReached'));
    session.quizQuestions = undefined;
    session.currentQuestionIndex = undefined;
    session.totalQuestions = undefined;
    session.isProcessing = false;
    return;
  }
  await maybeWarnLowQuota(session, (session.language as Language) || 'en', (text) => ctx.telegram.sendMessage(metadata.chatId, text));
  await sendQuestionPoll(ctx.telegram, metadata.chatId, userId, nextIndex, nextQ);

  // We can't easily reply to the *user* in a private chat context from a poll_answer event
  // without the chatId stored. We stored it in metadata.
  
  // Logic: 
  // User answered. Telegram native quiz shows correct/wrong + explanation.
  // If we want to send an EXTRA message:
  /*
  const selectedOption = answer.option_ids[0];
  const isCorrect = selectedOption === metadata.correctIndex;

  const replyText = isCorrect 
    ? `✅ Correct!\n\n${metadata.explanation}`
    : `❌ Wrong! The answer was option ${metadata.correctIndex + 1}.\n\n💡 Hint: ${metadata.hint}\n\n📖 Explanation: ${metadata.explanation}`;

  // Use telegram.sendMessage because ctx.reply might not target the chat correctly in some contexts
  await ctx.telegram.sendMessage(metadata.chatId, replyText);
  */
  
  // DECISION: The native `explanation` field in `sendPoll` covers the requirements 
  // "The bot replies with... Hint, Explanation" in the most "Production Ready" way (native UI).
  // Sending extra messages for every vote in a group chat is spammy.
  // I will rely on the `explanation` param in `ctx.replyWithPoll` above.
});

bot.action('more', async (ctx: any) => {
  const session = ctx.session as UserSession | undefined;
  const lang: Language = (session?.language as Language) || 'en';
  if (!session || !session.fileText) {
    await safeAnswerCbQuery(ctx);
    await safeEditMessageText(ctx, t(lang, 'uploadPrompt'));
    return;
  }

  // If we have a prefetched pool, unlock the next page without calling the LLM.
  if (
    Array.isArray(session.quizQuestions) &&
    session.questionCount &&
    session.currentQuestionIndex !== undefined &&
    session.totalQuestions !== undefined &&
    session.currentQuestionIndex >= session.totalQuestions &&
    session.quizQuestions.length > session.totalQuestions
  ) {
    const pageSize = Number(session.questionCount) || 0;
    const remainingQuota = getRemainingDailyQuestions(session);
    const unlockBy = Math.min(Math.max(1, pageSize), remainingQuota);
    if (unlockBy <= 0) {
      await safeAnswerCbQuery(ctx);
      await safeEditMessageText(ctx, t(lang, 'dailyLimitReached'));
      return;
    }

    const nextTotal = Math.min(session.totalQuestions + unlockBy, session.quizQuestions.length);
    session.totalQuestions = nextTotal;

    const nextQ = (session.quizQuestions as any[])[session.currentQuestionIndex];
    const chatId = (ctx.chat as any)?.id;
    const userId = (ctx.from as any)?.id;
    await safeAnswerCbQuery(ctx);

    const qType: QuestionType = (session.questionType as QuestionType) || 'poll';
    if (qType === 'open') {
      session.awaitingOpenAnswer = true;
      await safeEditMessageText(ctx, t(lang, 'adminDone'));
      await ctx.reply(t(lang, 'questionsLeftToday', { n: getRemainingDailyQuestions(session) }));
      if (!consumeDailyQuestions(session, 1)) {
        session.awaitingOpenAnswer = false;
        await ctx.reply(t(lang, 'dailyLimitReached'));
        return;
      }
      await maybeWarnLowQuota(session, lang, (text) => ctx.reply(text));
      await sendOpenQuestion(ctx, session.currentQuestionIndex, session.quizQuestions.length, nextQ);
      return;
    }

    if (!chatId || !userId) {
      await safeEditMessageText(ctx, t(lang, 'sessionExpired'));
      return;
    }
    if (!isPollQuestion(nextQ)) {
      await safeEditMessageText(ctx, t(lang, 'sessionExpired'));
      return;
    }

    await safeEditMessageText(ctx, t(lang, 'adminDone'));
    await ctx.reply(t(lang, 'questionsLeftToday', { n: getRemainingDailyQuestions(session) }));
    if (!consumeDailyQuestions(session, 1)) {
      await ctx.reply(t(lang, 'dailyLimitReached'));
      return;
    }
    await maybeWarnLowQuota(session, lang, (text) => ctx.reply(text));
    await sendQuestionPoll(ctx.telegram, chatId, userId, session.currentQuestionIndex, nextQ);
    return;
  }

  session.quizQuestions = undefined;
  session.currentQuestionIndex = undefined;
  session.totalQuestions = undefined;
  session.score = 0;
  session.questionCount = undefined;
  session.difficulty = undefined;
  session.isProcessing = false;
  session.awaitingOpenAnswer = false;

  await safeAnswerCbQuery(ctx);
  await safeEditMessageText(
    ctx,
    t(lang, 'howMany'),
    Markup.inlineKeyboard([
      Markup.button.callback('3', 'count_3'),
      Markup.button.callback('5', 'count_5'),
      Markup.button.callback('10', 'count_10'),
    ])
  );
});

bot.action('newfile', async (ctx: any) => {
  const session = ctx.session as UserSession | undefined;
  const lang: Language = (session?.language as Language) || 'en';
  if (!session) {
    await safeAnswerCbQuery(ctx);
    await safeEditMessageText(ctx, t(lang, 'uploadPrompt'));
    return;
  }

  session.fileText = undefined;
  session.questionType = undefined;
  session.questionCount = undefined;
  session.difficulty = undefined;
  session.askedQuestionTexts = undefined;
  session.generationRound = undefined;
  session.quizQuestions = undefined;
  session.currentQuestionIndex = undefined;
  session.totalQuestions = undefined;
  session.score = undefined;
  session.isProcessing = false;
  session.awaitingOpenAnswer = false;
  await safeAnswerCbQuery(ctx);
  await safeEditMessageText(ctx, t(lang, 'uploadPrompt'));
});

bot.catch((err: any) => {
  console.error('Bot error:', err);
});

export { bot };