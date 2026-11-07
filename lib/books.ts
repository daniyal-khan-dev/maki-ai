// The books a student can pick (dummy data for the demo; in the LMS these come from the courses).
import { readFileSync } from "fs";

export interface Chapter {
  title: string;
  notes: string;
}

export interface Book {
  id: string;
  title: string;
  subject: string;
  level: string;
  chapters: Chapter[];
}

export const BOOKS: Book[] = JSON.parse(readFileSync(new URL("../data/books.json", import.meta.url), "utf8"));

/** "Any subject (no book)" on the page: no background, the student can ask about anything. */
export const ANY_BOOK = "any";

export const findBook = (id: string | null | undefined): Book | null =>
  id === ANY_BOOK ? null : BOOKS.find((b) => b.id === id) || BOOKS[0];

/**
 * The context handed to the agents: the selected book and its chapters, as background. The
 * decision maker uses it to pick the teacher; the teacher links to a chapter when it fits.
 * (Worded and placed as background: attached to every question, the small models kept telling
 * students they were "in the wrong book".) Empty when no book is picked.
 */
export function bookContext(book: Book | null): string {
  if (!book) return "";
  const chapters = book.chapters.map((c, i) => `${i + 1}. ${c.title}: ${c.notes}`).join("\n");
  return `[Background]\nThe student is studying "${book.title}" (${book.level}, subject: ${book.subject}). Use this only when their question is about it.\nChapters:\n${chapters}\n[/Background]`;
}
