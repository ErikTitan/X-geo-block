# Twitter Account Location Flag & Geo-Blocker

A high-performance Chrome extension that displays country flag emojis next to Twitter/X usernames on the homepage based on the account's location information and allows you to block content from specific countries.

## New Features (v2.0)

This fork significantly improves upon the original extension with advanced optimizations and blocking capabilities:

### 🚀 Performance & Optimization
- **Hybrid Smart Caching**:
  - **Instant Processing**: Cached users are processed instantly as you scroll, preventing visual jumps.
  - **Debounced Fetching**: New users are processed with a slight delay (2000ms) to ensure you are actively viewing the tweet, saving API calls.
  - **Persistence**: Data is cached for 30 days.
- **Dynamic Rate Limiting**: Automatically adjusts request speed. Starts aggressive (300ms) for instant flags, but backs off intelligently if Twitter limits are approached.
- **Smart Scroll Optimization**: Uses debouncing and viewport detection to only fetch data for tweets you actually stop to read, significantly reducing API calls during fast scrolling.
- **Cache Management**: View cache size and manually clear it via the extension popup.

### 🛡️ Geo-Blocking
- **Country Blacklist**: Easily block posts from specific countries.
- **One-Click Block**: Click the small `+` button next to any flag to add that country to your blacklist instantly.
- **Content Hiding**: Posts from blacklisted countries are hidden with a "Show" button. You can re-hide them at any time.
- **No Layout Shift**: Optimized to prevent visual glitches when hiding/showing posts.

## Original Features

- Automatically detects usernames on Twitter/X pages
- Queries Twitter's GraphQL API (using secure page-context injection)
- Displays the corresponding country flag emoji next to usernames
- Works with dynamically loaded content (infinite scroll)

## Installation

1. Clone or download this repository
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable "Developer mode" (toggle in the top right)
4. Click "Load unpacked"
5. Select the directory containing this extension
6. The extension will now be active on Twitter/X pages

## How It Works

1. The extension runs a content script on all Twitter/X pages.
2. It identifies username elements in tweets and user profiles.
3. **Check Cache**: It first checks the local cache (valid for 30 days).
4. **API Request**: If not cached, it queries Twitter's GraphQL API endpoint (`AboutAccountQuery`) using a page script to ensure authentication.
5. **Rate Limiting**: Requests are queued and rate-limited to avoid hitting Twitter's API limits.
6. The location is mapped to a flag emoji using the country flags mapping.
7. The flag emoji is displayed next to the username, along with a block button.

## Files

- `manifest.json` - Chrome extension configuration
- `content.js` - Main content script (UI injection, caching, rate limiting)
- `popup.html` / `popup.js` - Extension popup for settings and cache management
- `countryFlags.js` - Country name to flag emoji mapping
- `README.md` - This file

## Technical Details

The extension uses **Page Script Injection** to make API requests. This allows it to:
- Access the same cookies and authentication as the logged-in user.
- Make same-origin requests to Twitter's API without CORS issues.
- Work seamlessly with Twitter's authentication system.

## Privacy

- The extension only queries public account information
- No data is stored or transmitted to third-party servers
- All API requests are made directly to Twitter/X servers
- Location data is cached locally in your browser

## License

MIT
