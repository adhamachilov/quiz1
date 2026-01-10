import pdf from 'pdf-parse';
import mammoth from 'mammoth';
import officeParser from 'officeparser';
import { Buffer } from 'buffer';

interface FileData {
  buffer: Buffer;
  mimeType: string;
  originalName?: string;
}

const inferMimeType = (mimeType: string, originalName?: string): string => {
  const mt = (mimeType || '').toLowerCase();
  if (mt && mt !== 'application/octet-stream') return mt;
  const name = (originalName || '').toLowerCase();
  if (name.endsWith('.pdf')) return 'application/pdf';
  if (name.endsWith('.docx')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (name.endsWith('.pptx')) return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  if (name.endsWith('.txt')) return 'text/plain';
  return mt || mimeType;
};

export const parseFileContent = async ({ buffer, mimeType, originalName }: FileData): Promise<string> => {
  const safeMimeType = inferMimeType(mimeType, originalName);
  try {
    switch (safeMimeType) {
      case 'application/pdf':
        // Cast pdf to any to avoid "This expression is not callable" typescript error
        // caused by mismatched type definitions for the default export.
        const pdfData = await (pdf as any)(buffer);
        if (!pdfData.text || pdfData.text.trim().length === 0) {
          throw new Error('Empty PDF content');
        }
        return pdfData.text;

      case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': // docx
        const docxData = await mammoth.extractRawText({ buffer });
        return docxData.value;

      case 'application/vnd.openxmlformats-officedocument.presentationml.presentation': // pptx
        try {
          const text = await (officeParser as any).parseOfficeAsync(buffer, {
            outputErrorToConsole: true,
            ignoreNotes: true,
          });
          if (!text || String(text).trim().length === 0) {
            throw new Error('Empty PPTX content');
          }
          return String(text);
        } catch (e) {
          console.error("PPTX Parse error", e);
          const cause = e instanceof Error ? e.message : String(e);
          throw new Error(`Failed to parse the PPTX file. It might be corrupted or in an unsupported format. (${cause})`);
        }

      case 'text/plain':
        return buffer.toString('utf-8');

      default:
        throw new Error('Unsupported file type');
    }
  } catch (error) {
    // If it's one of our specific errors, rethrow it directly so the user gets the specific message
    if (error instanceof Error && (
        error.message === 'Empty PDF content' || 
        error.message.includes('Failed to parse the PPTX file')
    )) {
        throw error;
    }

    console.error('File parsing failed:', error);
    throw new Error('Failed to extract text from file.');
  }
};