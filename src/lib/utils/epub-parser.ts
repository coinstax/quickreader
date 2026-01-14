import ePub, { type Book, type NavItem } from 'epubjs';
import type { ParsedDocument, ParsedWord } from './text-parser';

/**
 * Split a word on em-dashes, en-dashes, and ellipsis, keeping the punctuation with the first word.
 * "consciousness—seemed" becomes ["consciousness—", "seemed"]
 * "delusion…created" becomes ["delusion…", "created"]
 */
function splitOnDashes(word: string): string[] {
	const splitPattern = /(—|–|…|\.\.\.)/;

	if (!splitPattern.test(word)) {
		return [word];
	}

	const result: string[] = [];
	const parts = word.split(splitPattern);

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		if (part === '—' || part === '–' || part === '…' || part === '...') {
			if (result.length > 0) {
				result[result.length - 1] += part;
			}
		} else if (part.length > 0) {
			result.push(part);
		}
	}

	return result.filter(w => w.length > 0);
}

interface FormattedWord {
	text: string;
	italic: boolean;
	bold: boolean;
}

/**
 * Extract words from a DOM element while preserving italic/bold formatting.
 */
function extractFormattedWords(element: Element): FormattedWord[] {
	const words: FormattedWord[] = [];

	function walk(node: Node, italic: boolean, bold: boolean) {
		if (node.nodeType === Node.TEXT_NODE) {
			const text = node.textContent || '';
			const rawWords = text.split(/\s+/).filter(w => w.length > 0);
			const splitWords = rawWords.flatMap(splitOnDashes);

			for (const word of splitWords) {
				words.push({ text: word, italic, bold });
			}
		} else if (node.nodeType === Node.ELEMENT_NODE) {
			const el = node as Element;
			const tagName = el.tagName.toLowerCase();

			// Check for formatting tags
			const isItalic = italic || tagName === 'i' || tagName === 'em';
			const isBold = bold || tagName === 'b' || tagName === 'strong';

			// Skip script and style tags
			if (tagName === 'script' || tagName === 'style') {
				return;
			}

			// Recurse into children
			for (const child of Array.from(node.childNodes)) {
				walk(child, isItalic, isBold);
			}
		}
	}

	walk(element, false, false);
	return words;
}

/**
 * Extended parsed document with EPUB-specific information.
 */
export interface ParsedEpub extends ParsedDocument {
	title: string;
	author: string;
	chapters: ChapterInfo[];
	chapterStarts: number[]; // Word indices where chapters start
	parseWarnings: string[]; // Warnings encountered during parsing
}

export interface ChapterInfo {
	title: string;
	href: string;
	wordStart: number;
	wordEnd: number;
}

/**
 * Parse an EPUB file into words with chapter, paragraph, and page tracking.
 */
export async function parseEpub(file: File): Promise<ParsedEpub> {
	const arrayBuffer = await file.arrayBuffer();
	const book: Book = ePub(arrayBuffer);

	await book.ready;

	// Get metadata
	const metadata = await book.loaded.metadata;
	const title = metadata.title || file.name.replace(/\.epub$/i, '');
	const author = metadata.creator || 'Unknown Author';

	// Get navigation/TOC
	const navigation = await book.loaded.navigation;
	const toc: NavItem[] = navigation.toc || [];

	const words: ParsedWord[] = [];
	const paragraphStarts: number[] = [];
	const pageStarts: number[] = [0];
	const chapters: ChapterInfo[] = [];
	const chapterStarts: number[] = [];
	const parseWarnings: string[] = [];

	let wordIndex = 0;
	let paragraphIndex = 0;
	let currentPage = 0;

	// Get spine items (the reading order)
	const spine = book.spine;

	// epub.js stores spine items in different properties depending on version
	let spineItems: any[] = [];

	// Try different ways to access spine items
	if ((spine as any).spineItems && Array.isArray((spine as any).spineItems)) {
		spineItems = (spine as any).spineItems;
	} else if ((spine as any).items && Array.isArray((spine as any).items)) {
		spineItems = (spine as any).items;
	} else if (typeof (spine as any).each === 'function') {
		// Use the each() iterator if available
		(spine as any).each((item: any) => spineItems.push(item));
	} else if ((spine as any).length) {
		// Try accessing by index
		for (let i = 0; i < (spine as any).length; i++) {
			const item = (spine as any).get(i);
			if (item) spineItems.push(item);
		}
	}

	if (spineItems.length === 0) {
		parseWarnings.push('No spine items found in EPUB - the file may be malformed or use an unsupported format');
	}

	// Process each spine item (section/chapter)
	for (const spineItem of spineItems) {
		const chapterStartWord = wordIndex;
		chapterStarts.push(chapterStartWord);

		// Find chapter title from TOC
		const tocEntry = toc.find(t => spineItem.href.includes(t.href.split('#')[0]));
		const chapterTitle = tocEntry?.label || `Section ${chapters.length + 1}`;

		try {
			// Load the section content - spineItem might be a Section object itself
			let section = spineItem;
			if (typeof spineItem.load !== 'function') {
				// It's just a reference, need to get actual section
				section = await book.section(spineItem.href || spineItem.idref);
			}

			if (!section) {
				parseWarnings.push(`Section not found: ${spineItem.href || spineItem.idref}`);
				continue;
			}

			let contents: string | Document | null = null;
			try {
				contents = await section.load(book.load.bind(book));
			} catch (loadErr) {
				console.warn('Section load error:', loadErr);
				// Try alternative loading method
				try {
					const url = await book.resolve(spineItem.href || spineItem.idref);
					if (url) {
						const response = await fetch(url);
						const html = await response.text();
						contents = html;
					}
				} catch {
					// Ignore fetch errors
				}
			}

			if (!contents) {
				parseWarnings.push(`Could not load content for: ${chapterTitle}`);
				continue;
			}

			// Extract words with formatting from content
			let formattedWords: FormattedWord[] = [];

			if (contents instanceof Element) {
				// HTMLHtmlElement or other Element - find body and extract formatted words
				const el = contents as Element;
				let bodyEl: Element | null = el.querySelector('body');

				// If querySelector fails (XHTML namespace issues), try other methods
				if (!bodyEl) {
					bodyEl = el.getElementsByTagName('body')[0] || null;
				}
				if (!bodyEl && el.children) {
					for (let i = 0; i < el.children.length; i++) {
						if (el.children[i].tagName.toLowerCase() === 'body') {
							bodyEl = el.children[i];
							break;
						}
					}
				}

				// Extract formatted words from body (or whole element if no body)
				formattedWords = extractFormattedWords(bodyEl || el);
			} else if (contents instanceof Document) {
				if (contents.body) {
					formattedWords = extractFormattedWords(contents.body);
				}
			} else if (typeof contents === 'string') {
				// Plain string - strip HTML and split (no formatting)
				const textContent = stripHtml(contents);
				const rawWords = textContent.split(/\s+/).filter(w => w.length > 0);
				formattedWords = rawWords.flatMap(splitOnDashes).map(text => ({
					text,
					italic: false,
					bold: false
				}));
			} else {
				// Fallback: try to get textContent
				const textContent = (contents as any)?.textContent || '';
				const rawWords = textContent.split(/\s+/).filter((w: string) => w.length > 0);
				formattedWords = rawWords.flatMap(splitOnDashes).map((text: string) => ({
					text,
					italic: false,
					bold: false
				}));
			}

			// Mark section as a paragraph
			if (formattedWords.length > 0) {
				paragraphStarts.push(wordIndex);

				for (const fw of formattedWords) {
					// Check for page break (every 250 words)
					if (wordIndex > 0 && wordIndex % 250 === 0) {
						currentPage++;
						pageStarts.push(wordIndex);
					}

					words.push({
						text: fw.text,
						paragraphIndex,
						pageIndex: currentPage,
						italic: fw.italic || undefined,
						bold: fw.bold || undefined
					});

					wordIndex++;
				}

				paragraphIndex++;
			}
		} catch (e) {
			const errorMsg = e instanceof Error ? e.message : 'Unknown error';
			const warning = `Failed to parse chapter "${chapterTitle}": ${errorMsg}`;
			parseWarnings.push(warning);
			console.warn(warning, e);
		}

		chapters.push({
			title: chapterTitle,
			href: spineItem.href,
			wordStart: chapterStartWord,
			wordEnd: wordIndex - 1
		});
	}

	// Clean up
	book.destroy();

	return {
		words,
		paragraphStarts,
		pageStarts,
		chapterStarts,
		chapters,
		title,
		author,
		totalWords: words.length,
		totalParagraphs: paragraphIndex,
		totalPages: pageStarts.length,
		parseWarnings
	};
}

/**
 * Strip HTML tags from a string.
 */
function stripHtml(html: string): string {
	// Create a temporary div to parse HTML
	if (typeof DOMParser !== 'undefined') {
		try {
			const parser = new DOMParser();
			const doc = parser.parseFromString(html, 'text/html');
			return doc.body?.textContent || '';
		} catch {
			// Fallback to regex
		}
	}

	// Fallback: simple regex-based HTML stripping
	return html
		.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
		.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/\s+/g, ' ')
		.trim();
}

/**
 * Find the chapter for a given word index.
 */
export function getChapterForWordIndex(doc: ParsedEpub, wordIndex: number): number {
	for (let i = doc.chapterStarts.length - 1; i >= 0; i--) {
		if (doc.chapterStarts[i] <= wordIndex) {
			return i;
		}
	}
	return 0;
}

/**
 * Get word index for start of a chapter.
 */
export function getWordIndexForChapter(doc: ParsedEpub, chapterIndex: number): number {
	if (chapterIndex < 0) return 0;
	if (chapterIndex >= doc.chapterStarts.length) {
		return doc.totalWords - 1;
	}
	return doc.chapterStarts[chapterIndex];
}
