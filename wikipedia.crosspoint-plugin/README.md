Wikipedia for CrossPoint

Import articles with your phone or computer, then read them offline.

1. Enable Settings > Connectivity > Plugins.
2. On the reader, open File Transfer > Join Network.
3. Connect your phone to the same Wi-Fi and scan the reader's URL QR code.
4. Open File Manager and scroll to the Wikipedia card.
5. Search for an article or paste a Wikipedia article URL. Choose a preview.
6. Select Add to reader. Keep the page and File Transfer open until saved.
7. Exit File Transfer. Open Browse Files > Wikipedia to read your articles.

Your phone needs internet access to fetch Wikipedia. Reader hotspot mode does
not provide internet access. Shared Wi-Fi is recommended.

Language defaults to en. Enter another Wikipedia language code, such as fr,
de, or simple. Pasting a URL selects that article's language automatically.
Font coverage and right-to-left rendering depend on your reader configuration.

Articles are EPUB files in /Wikipedia, and also appear in the normal Library.
Enable Embedded Style in Reader settings to use the article layout. Font size,
font choice, margins, and image display remain under your reader's control.

Infoboxes become stacked facts with explicit labels. Image galleries become
stacked figures with captions. Simple wide tables use one labeled field per line. Complex tables are replaced with a short
omission notice; table titles, captions, and surrounding explanations remain.
Tables with code examples also stack when their column headers are clear.
Chessboards, family-tree diagrams, and interactive maps also use explicit
omission notices, preserving captions and nearby prose. Simple inline mathematics
stays text; complex formulas become grayscale PNGs, with their own 256-image/3 MB
budget. Oversized or unavailable equations use omission notices. Formulas are
included even with article photos disabled; enable image display on the reader.
Navigation banners, sidebars, template controls, citation appendices and
audio/video-only entries are omitted. Pronunciation text is preserved.

Images are optimized for the X4: grayscale JPEG, at most 448 by 560 pixels,
leaving extra room for captions. Long captions may continue onto the next page,
depending on reader font settings.
Up to 40 verified freely licensed images are included within a 4 MB photo budget; unavailable, non-free,
or unverified images are replaced by their alternative text. Captions remain.
Article and image credits are retained in EPUB metadata.
Equations are typeset locally in the browser using bundled MathJax (Apache-2.0).

Replace existing article is enabled by default. Uncheck it to keep an existing copy. The filename includes the language and Wikipedia page ID.
Download EPUB saves a copy on your phone without uploading to the reader.

JSZip is reused from File Manager. If unavailable, the plugin tries the reader's
JSZip endpoint, then JSZip 3.10.1 from jsDelivr. No account or API key is needed.

Manual installation: copy this folder to /plugins/wikipedia on the SD card.
The folder must contain manifest.json and plugin.js directly.

Source: https://github.com/saadasif/crosspoint-wikipedia

Optional font setup: expand Optional reader font in the Wikipedia card. Install
Inter adds the bundled InterWiki font family, including pronunciation symbols and
common scientific symbols. After installation, select the font manually in
Settings > Reader > Font Family > InterWiki. This reader setting applies to all
books. Installation can resume after an error and skips complete
matching files. Some foreign scripts and scientific symbols may need other fonts.
Arabic, Persian, Urdu, and Hebrew glyphs are included, along with Greek and Cyrillic.
Arabic joining and script marks depend on the reader's rendering support.
After a plugin update, run Install Inter again and restart the reader to reload
updated fonts. Existing EPUBs retain their original text and do not need reimporting.
The font pack includes its own Inter and Noto font licenses.
