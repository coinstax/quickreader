<script lang="ts">
	import { reader, currentWordIndex, currentPage, isPlaying } from '../stores/reader';
	import { documentStore, totalPages } from '../stores/document';
	import { currentTheme } from '../stores/settings';
	import type { ParsedEpubWithContent, ChapterContent } from '../utils/epub-parser';
	import type { ParsedDocument } from '../utils/text-parser';

	// Reactive state
	const wordIndex = $derived($currentWordIndex);
	const pageIndex = $derived($currentPage);
	const pageCount = $derived($totalPages);
	const doc = $derived($documentStore);
	const theme = $derived($currentTheme);
	const playing = $derived($isPlaying);

	// Get page boundaries from document
	const pageBounds = $derived.by((): [number, number] | null => {
		if (!doc.document) return null;

		const pageStarts = doc.document.pageStarts;
		if (!pageStarts || pageStarts.length === 0) return null;

		const startIdx = pageStarts[pageIndex] ?? 0;
		const endIdx = pageStarts[pageIndex + 1] !== undefined
			? pageStarts[pageIndex + 1] - 1
			: doc.document.totalWords - 1;

		return [startIdx, endIdx];
	});

	// For EPUB: Get current chapter's HTML and filter to current page
	const epubPageHtml = $derived.by((): string | null => {
		if (!doc.document || doc.fileType !== 'epub' || !pageBounds) return null;

		const epubDoc = doc.document as ParsedEpubWithContent;
		if (!epubDoc.chapterContents) return null;

		const [pageStart, pageEnd] = pageBounds;

		// Find chapter containing CURRENT WORD (not page start)
		const chapter = epubDoc.chapterContents.find(
			c => wordIndex >= c.wordRange[0] && wordIndex <= c.wordRange[1]
		);

		if (!chapter?.htmlWithMarkers) return null;

		// Parse HTML and filter to only show words in current page range
		const parser = new DOMParser();
		const htmlDoc = parser.parseFromString(chapter.htmlWithMarkers, 'text/html');

		// Find all word spans and hide those outside page range
		const wordSpans = htmlDoc.querySelectorAll('[data-word-index]');
		wordSpans.forEach(span => {
			const idx = parseInt(span.getAttribute('data-word-index') || '', 10);
			if (isNaN(idx) || idx < pageStart || idx > pageEnd) {
				// Hide words outside current page
				(span as HTMLElement).style.display = 'none';
			}
		});

		// Remove empty paragraphs/elements that have no visible content
		const allElements = htmlDoc.body.querySelectorAll('p, li, h1, h2, h3, h4, h5, h6, div');
		allElements.forEach(el => {
			const visibleWords = el.querySelectorAll('[data-word-index]:not([style*="display: none"])');
			if (visibleWords.length === 0) {
				(el as HTMLElement).style.display = 'none';
			}
		});

		return htmlDoc.body.innerHTML;
	});

	// For plain text: Generate HTML for the current page
	const textPageHtml = $derived.by((): string | null => {
		if (!doc.document || doc.fileType !== 'text' || !pageBounds) return null;

		const [startIdx, endIdx] = pageBounds;
		const words = doc.document.words;

		if (!words || words.length === 0) return null;

		// Group words by paragraph for proper formatting
		const paragraphs: Map<number, string[]> = new Map();

		for (let i = startIdx; i <= endIdx && i < words.length; i++) {
			const word = words[i];
			const pIdx = word.paragraphIndex;

			if (!paragraphs.has(pIdx)) {
				paragraphs.set(pIdx, []);
			}

			// Create span with word index and styling
			let wordHtml = `<span data-word-index="${i}"`;
			const styles: string[] = [];
			if (word.italic) styles.push('font-style: italic');
			if (word.bold) styles.push('font-weight: bold');
			if (styles.length > 0) wordHtml += ` style="${styles.join('; ')}"`;
			wordHtml += `>${escapeHtml(word.text)}</span>`;

			paragraphs.get(pIdx)!.push(wordHtml);
		}

		// Build HTML from paragraphs
		const sortedParas = Array.from(paragraphs.entries()).sort((a, b) => a[0] - b[0]);
		return sortedParas.map(([_, wordList]) => `<p>${wordList.join(' ')}</p>`).join('\n');
	});

	// Combined preview HTML
	const pagePreviewHtml = $derived(epubPageHtml || textPageHtml);

	// Escape HTML special characters
	function escapeHtml(text: string): string {
		return text
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#039;');
	}

	// Highlight current word (no scroll - just highlight)
	$effect(() => {
		// Capture wordIndex before setTimeout so Svelte tracks the dependency
		const currentIdx = wordIndex;

		// Use a small delay to ensure DOM is updated after page change
		const timeout = setTimeout(() => {
			const container = document.querySelector('.preview-content');
			if (!container) return;

			// Remove previous highlight
			const prev = container.querySelector('[data-word-index].current');
			prev?.classList.remove('current');

			// Add new highlight
			const current = container.querySelector(`[data-word-index="${currentIdx}"]`);
			if (current) {
				current.classList.add('current');
			}
		}, 0);

		return () => clearTimeout(timeout);
	});

	// Handle click on words to navigate
	function handleWordNavigation(target: HTMLElement) {
		const wordSpan = target.closest('[data-word-index]');

		if (wordSpan) {
			const index = parseInt(wordSpan.getAttribute('data-word-index') || '', 10);
			if (!isNaN(index)) {
				reader.setWordIndex(index);
			}
		}
	}

	function handleClick(event: MouseEvent) {
		handleWordNavigation(event.target as HTMLElement);
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			handleWordNavigation(event.target as HTMLElement);
		}
	}
</script>

<div
	class="preview-container"
	class:is-playing={playing}
	style:--text-color={theme.text}
	style:--bg-color={theme.background}
	style:--orp-color={theme.orp}
	style:--guide-color={theme.guideLines}
>
	<div class="preview-header">
		<span class="preview-title">Page {pageIndex + 1} of {pageCount}</span>
	</div>

	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions a11y_no_noninteractive_tabindex -->
	<div
		class="preview-content"
		onclick={handleClick}
		onkeydown={handleKeydown}
		tabindex="0"
		role="application"
		aria-label="Page preview. Click on any word to navigate to it."
	>
		<div class="page-box">
			{#if pagePreviewHtml}
				{@html pagePreviewHtml}
			{:else if !doc.document}
				<p class="preview-message">Load a document to see preview</p>
			{:else}
				<p class="preview-message">No preview available</p>
			{/if}
		</div>
	</div>
</div>

<style>
	.preview-container {
		display: flex;
		flex-direction: column;
		height: 100%;
		background-color: var(--bg-color);
		color: var(--text-color);
		border-radius: 8px;
		overflow: hidden;
	}

	.preview-header {
		padding: 0.75rem 1rem;
		border-bottom: 1px solid var(--guide-color);
		flex-shrink: 0;
	}

	.preview-title {
		font-size: 0.875rem;
		font-weight: 600;
		opacity: 0.7;
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	.preview-content {
		flex: 1;
		overflow-y: auto;
		padding: 1rem;
		display: flex;
		justify-content: center;
		align-items: flex-start;
	}

	.page-box {
		background: var(--bg-color);
		border: 1px solid var(--guide-color);
		border-radius: 4px;
		padding: 1.5rem;
		max-width: 100%;
		width: 100%;
		min-height: 300px;
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
		font-size: 0.9rem;
		line-height: 1.7;
	}

	/* Style for word spans */
	.page-box :global([data-word-index]) {
		cursor: pointer;
		border-radius: 2px;
		padding: 0 1px;
		transition: background-color 0.15s ease;
	}

	.page-box :global([data-word-index]:hover) {
		background-color: rgba(128, 128, 128, 0.2);
	}

	/* Current word highlight - bright when paused */
	.page-box :global([data-word-index].current) {
		background-color: var(--orp-color);
		color: var(--bg-color);
		padding: 0 2px;
		font-weight: 600;
	}

	/* Subtle highlight when actively reading - not distracting in peripheral vision */
	.preview-container.is-playing .page-box :global([data-word-index].current) {
		background-color: rgba(128, 128, 128, 0.15);
		color: inherit;
		font-weight: inherit;
	}

	/* Paragraph styling */
	.page-box :global(p) {
		margin: 0 0 1em 0;
	}

	.page-box :global(p:last-child) {
		margin-bottom: 0;
	}

	.preview-message {
		opacity: 0.5;
		font-style: italic;
		text-align: center;
		padding: 2rem;
	}

	/* Scrollbar styling */
	.preview-content::-webkit-scrollbar {
		width: 8px;
	}

	.preview-content::-webkit-scrollbar-track {
		background: transparent;
	}

	.preview-content::-webkit-scrollbar-thumb {
		background-color: var(--guide-color);
		border-radius: 4px;
	}

	.preview-content::-webkit-scrollbar-thumb:hover {
		background-color: var(--text-color);
		opacity: 0.5;
	}
</style>
