// Cache for user locations - persistent storage
let locationCache = new Map();
const CACHE_KEY = 'twitter_location_cache';
const CACHE_EXPIRY_DAYS = 30; // Cache for 30 days

// Rate limiting
const requestQueue = [];
let isProcessingQueue = false;
let lastRequestTime = 0;
// Dynamic Rate Limiting
const INITIAL_REQUEST_INTERVAL = 300; // Start fast (300ms)
let currentRequestInterval = INITIAL_REQUEST_INTERVAL;
const MAX_REQUEST_INTERVAL = 10000; // Max backoff to 10s
const MAX_CONCURRENT_REQUESTS = 2;
let activeRequests = 0;
let rateLimitResetTime = 0; // Unix timestamp when rate limit resets

// Observer for dynamically loaded content
let observer = null;

// Visibility observer to only process visible elements (saves API calls)
const visibilityObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      const element = entry.target;
      // Stop observing once processed
      visibilityObserver.unobserve(element);
      
      // Now process the element
      const screenName = extractUsername(element);
      if (screenName) {
        addFlagToUsername(element, screenName).catch(err => {
          console.error(`Error processing ${screenName}:`, err);
          element.dataset.flagAdded = 'failed';
        });
      }
    }
  });
}, { rootMargin: '300px' }); // Pre-fetch 300px before they enter viewport

// Extension enabled state
let extensionEnabled = true;
const TOGGLE_KEY = 'extension_enabled';
const DEFAULT_ENABLED = true;
const BLACKLIST_KEY = 'blocked_countries';
let blockedCountries = [];

// Track usernames currently being processed to avoid duplicate requests
const processingUsernames = new Set();

// Load enabled state
async function loadEnabledState() {
  try {
    const result = await chrome.storage.local.get([TOGGLE_KEY, BLACKLIST_KEY]);
    extensionEnabled = result[TOGGLE_KEY] !== undefined ? result[TOGGLE_KEY] : DEFAULT_ENABLED;
    blockedCountries = result[BLACKLIST_KEY] || [];
    console.log('Extension enabled:', extensionEnabled);
    console.log('Blocked countries:', blockedCountries);
  } catch (error) {
    console.error('Error loading enabled state:', error);
    extensionEnabled = DEFAULT_ENABLED;
    blockedCountries = [];
  }
}

// Listen for toggle changes from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'extensionToggle') {
    extensionEnabled = request.enabled;
    console.log('Extension toggled:', extensionEnabled);
    
    if (extensionEnabled) {
      // Re-initialize if enabled
      setTimeout(() => {
        processUsernames();
      }, 500);
    } else {
      // Remove all flags if disabled
      removeAllFlags();
    }
  } else if (request.type === 'clearCache') {
    console.log('Clearing location cache...');
    locationCache.clear();
    saveCache(); // Save empty cache
  }
});

// Listen for blacklist changes
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'local' && changes[BLACKLIST_KEY]) {
    blockedCountries = changes[BLACKLIST_KEY].newValue || [];
    console.log('Blacklist updated:', blockedCountries);
    // Reprocess usernames to apply new rules (simple way: processUsernames)
    // Note: This won't unhide already hidden posts easily, but will hide new matches
    processUsernames();
  }
});

// Load cache from persistent storage
async function loadCache() {
  try {
    // Check if extension context is still valid
    if (!chrome.runtime?.id) {
      console.log('Extension context invalidated, skipping cache load');
      return;
    }
    
    const result = await chrome.storage.local.get(CACHE_KEY);
    if (result[CACHE_KEY]) {
      const cached = result[CACHE_KEY];
      const now = Date.now();
      
      // Filter out expired entries and null entries (allow retry)
      for (const [username, data] of Object.entries(cached)) {
        // Handle legacy format where cache might store string or incomplete object
        if (typeof data === 'string') {
          // Legacy string format - upgrade it
          locationCache.set(username, {
            location: data,
            expiry: now + (CACHE_EXPIRY_DAYS * 24 * 60 * 60 * 1000),
            cachedAt: now
          });
        } else if (data.expiry && data.expiry > now && data.location !== null) {
          // Valid object format
          locationCache.set(username, data);
        }
      }
      console.log(`Loaded ${locationCache.size} cached locations (excluding null entries)`);
    }
  } catch (error) {
    // Extension context invalidated errors are expected when extension is reloaded
    if (error.message?.includes('Extension context invalidated') || 
        error.message?.includes('message port closed')) {
      console.log('Extension context invalidated, cache load skipped');
    } else {
      console.error('Error loading cache:', error);
    }
  }
}

// Save cache to persistent storage
async function saveCache() {
  try {
    // Check if extension context is still valid
    if (!chrome.runtime?.id) {
      console.log('Extension context invalidated, skipping cache save');
      return;
    }
    
    const cacheObj = {};
    const now = Date.now();
    const defaultExpiry = now + (CACHE_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
    
    for (const [username, data] of locationCache.entries()) {
      // Ensure we have a valid object structure
      if (typeof data === 'object' && data !== null && data.location) {
        cacheObj[username] = data;
      } else if (typeof data === 'string') {
        // Fix any string entries that might have slipped in
        cacheObj[username] = {
          location: data,
          expiry: defaultExpiry,
          cachedAt: now
        };
      }
    }
    
    await chrome.storage.local.set({ [CACHE_KEY]: cacheObj });
  } catch (error) {
    // Extension context invalidated errors are expected when extension is reloaded
    if (error.message?.includes('Extension context invalidated') || 
        error.message?.includes('message port closed')) {
      console.log('Extension context invalidated, cache save skipped');
    } else {
      console.error('Error saving cache:', error);
    }
  }
}

// Save a single entry to cache
async function saveCacheEntry(username, location) {
  // Check if extension context is still valid
  if (!chrome.runtime?.id) {
    console.log('Extension context invalidated, skipping cache entry save');
    return;
  }
  
  const now = Date.now();
  const entry = {
    location: location,
    expiry: now + (CACHE_EXPIRY_DAYS * 24 * 60 * 60 * 1000),
    cachedAt: now
  };

  locationCache.set(username, entry);
  
  // Debounce saves - only save every 5 seconds
  if (!saveCache.timeout) {
    saveCache.timeout = setTimeout(async () => {
      await saveCache();
      saveCache.timeout = null;
    }, 5000);
  }
}

// Inject script into page context to access fetch with proper cookies
function injectPageScript() {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('pageScript.js');
  script.onload = function() {
    this.remove();
  };
  (document.head || document.documentElement).appendChild(script);
  
  // Listen for rate limit info from page script
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data && event.data.type === '__rateLimitInfo') {
      rateLimitResetTime = event.data.resetTime;
      const waitTime = event.data.waitTime;
      console.log(`Rate limit detected. Will resume requests in ${Math.ceil(waitTime / 1000 / 60)} minutes`);
    }
  });
}

// Process request queue with rate limiting
async function processRequestQueue() {
  if (isProcessingQueue || requestQueue.length === 0) {
    return;
  }
  
  // Check if we're rate limited
  if (rateLimitResetTime > 0) {
    const now = Math.floor(Date.now() / 1000);
    if (now < rateLimitResetTime) {
      const waitTime = (rateLimitResetTime - now) * 1000;
      console.log(`Rate limited. Waiting ${Math.ceil(waitTime / 1000 / 60)} minutes...`);
      setTimeout(processRequestQueue, Math.min(waitTime, 60000)); // Check every minute max
      return;
    } else {
      // Rate limit expired, reset
      rateLimitResetTime = 0;
    }
  }
  
  isProcessingQueue = true;
  
  while (requestQueue.length > 0 && activeRequests < MAX_CONCURRENT_REQUESTS) {
    const now = Date.now();
    const timeSinceLastRequest = now - lastRequestTime;
    
    // Wait if needed to respect dynamic rate limit
    if (timeSinceLastRequest < currentRequestInterval) {
      await new Promise(resolve => setTimeout(resolve, currentRequestInterval - timeSinceLastRequest));
    }
    
    const { screenName, resolve, reject } = requestQueue.shift();
    activeRequests++;
    lastRequestTime = Date.now();
    
    // Make the request
    makeLocationRequest(screenName)
      .then(location => {
        resolve(location);
      })
      .catch(error => {
        reject(error);
      })
      .finally(() => {
        activeRequests--;
        // Continue processing queue
        setTimeout(processRequestQueue, 200);
      });
  }
  
  isProcessingQueue = false;
}

// Make actual API request
function makeLocationRequest(screenName) {
  return new Promise((resolve, reject) => {
    const requestId = Date.now() + Math.random();
    
    // Listen for response via postMessage
    const handler = (event) => {
      // Only accept messages from the page (not from extension)
      if (event.source !== window) return;
      
      if (event.data && 
          event.data.type === '__locationResponse' &&
          event.data.screenName === screenName && 
          event.data.requestId === requestId) {
        window.removeEventListener('message', handler);
        const location = event.data.location;
        const isRateLimited = event.data.isRateLimited || false;
        
        // Only cache if not rate limited (don't cache failures due to rate limiting)
        if (!isRateLimited) {
          saveCacheEntry(screenName, location || null);
          
          // Successful request, slowly decrease interval if it's high
          if (currentRequestInterval > INITIAL_REQUEST_INTERVAL) {
             currentRequestInterval = Math.max(INITIAL_REQUEST_INTERVAL, currentRequestInterval - 100);
             console.log(`Decreasing request interval to ${currentRequestInterval}ms`);
          }
        } else {
          console.log(`Not caching null for ${screenName} due to rate limit`);
          // Rate limited! Increase interval significantly
          currentRequestInterval = Math.min(MAX_REQUEST_INTERVAL, currentRequestInterval * 2);
          console.log(`Rate limited (soft)! Increasing request interval to ${currentRequestInterval}ms`);
        }
        
        resolve(location || null);
      }
    };
    window.addEventListener('message', handler);
    
    // Send fetch request to page script via postMessage
    window.postMessage({
      type: '__fetchLocation',
      screenName,
      requestId
    }, '*');
    
    // Timeout after 10 seconds
    setTimeout(() => {
      window.removeEventListener('message', handler);
      // Don't cache timeout failures - allow retry
      console.log(`Request timeout for ${screenName}, not caching`);
      resolve(null);
    }, 10000);
  });
}

// Function to query Twitter GraphQL API for user location (with rate limiting)
async function getUserLocation(screenName) {
  // Check cache first
  if (locationCache.has(screenName)) {
    const cached = locationCache.get(screenName);
    
    // Handle object structure
    const location = (typeof cached === 'object' && cached !== null) ? cached.location : cached;

    // Don't return cached null - retry if it was null before (might have been rate limited)
    if (location !== null) {
      console.log(`Using cached location for ${screenName}: ${location}`);
      return location;
    } else {
      console.log(`Found null in cache for ${screenName}, will retry API call`);
      // Remove from cache to allow retry
      locationCache.delete(screenName);
    }
  }
  
  console.log(`Queueing API request for ${screenName}`);
  // Queue the request
  return new Promise((resolve, reject) => {
    requestQueue.push({ screenName, resolve, reject });
    processRequestQueue();
  });
}

// Function to extract username from various Twitter UI elements
function extractUsername(element) {
  // Try data-testid="UserName" or "User-Name" first (most reliable)
  const usernameElement = element.querySelector('[data-testid="UserName"], [data-testid="User-Name"]');
  if (usernameElement) {
    const links = usernameElement.querySelectorAll('a[href^="/"]');
    for (const link of links) {
      const href = link.getAttribute('href');
      const match = href.match(/^\/([^\/\?]+)/);
      if (match && match[1]) {
        const username = match[1];
        // Filter out common routes
        const excludedRoutes = ['home', 'explore', 'notifications', 'messages', 'i', 'compose', 'search', 'settings', 'bookmarks', 'lists', 'communities'];
        if (!excludedRoutes.includes(username) && 
            !username.startsWith('hashtag') &&
            !username.startsWith('search') &&
            username.length > 0 &&
            username.length < 20) { // Usernames are typically short
          return username;
        }
      }
    }
  }
  
  // Try finding username links in the entire element (broader search)
  const allLinks = element.querySelectorAll('a[href^="/"]');
  const seenUsernames = new Set();
  
  for (const link of allLinks) {
    const href = link.getAttribute('href');
    if (!href) continue;
    
    const match = href.match(/^\/([^\/\?]+)/);
    if (!match || !match[1]) continue;
    
    const potentialUsername = match[1];
    
    // Skip if we've already checked this username
    if (seenUsernames.has(potentialUsername)) continue;
    seenUsernames.add(potentialUsername);
    
    // Filter out routes and invalid usernames
    const excludedRoutes = ['home', 'explore', 'notifications', 'messages', 'i', 'compose', 'search', 'settings', 'bookmarks', 'lists', 'communities', 'hashtag'];
    if (excludedRoutes.some(route => potentialUsername === route || potentialUsername.startsWith(route))) {
      continue;
    }
    
    // Skip status/tweet links
    if (potentialUsername.includes('status') || potentialUsername.match(/^\d+$/)) {
      continue;
    }
    
    // Check link text/content for username indicators
    const text = link.textContent?.trim() || '';
    const linkText = text.toLowerCase();
    const usernameLower = potentialUsername.toLowerCase();
    
    // If link text starts with @, it's definitely a username
    if (text.startsWith('@')) {
      return potentialUsername;
    }
    
    // If link text matches the username (without @), it's likely a username
    if (linkText === usernameLower || linkText === `@${usernameLower}`) {
      return potentialUsername;
    }
    
    // Check if link is in a UserName container or has username-like structure
    const parent = link.closest('[data-testid="UserName"], [data-testid="User-Name"]');
    if (parent) {
      // If it's in a UserName container and looks like a username, return it
      if (potentialUsername.length > 0 && potentialUsername.length < 20 && !potentialUsername.includes('/')) {
        return potentialUsername;
      }
    }
    
    // Also check if link text is @username format
    if (text && text.trim().startsWith('@')) {
      const atUsername = text.trim().substring(1);
      if (atUsername === potentialUsername) {
        return potentialUsername;
      }
    }
  }
  
  // Last resort: look for @username pattern in text content and verify with link
  const textContent = element.textContent || '';
  const atMentionMatches = textContent.matchAll(/@([a-zA-Z0-9_]+)/g);
  for (const match of atMentionMatches) {
    const username = match[1];
    // Verify it's actually a link in a User-Name container
    const link = element.querySelector(`a[href="/${username}"], a[href^="/${username}?"]`);
    if (link) {
      // Make sure it's in a username context, not just mentioned in tweet text
      const isInUserNameContainer = link.closest('[data-testid="UserName"], [data-testid="User-Name"]');
      if (isInUserNameContainer) {
        return username;
      }
    }
  }
  
  return null;
}

// Helper function to find handle section
function findHandleSection(container, screenName) {
  return Array.from(container.querySelectorAll('div')).find(div => {
    const link = div.querySelector(`a[href="/${screenName}"]`);
    if (link) {
      const text = link.textContent?.trim();
      return text === `@${screenName}`;
    }
    return false;
  });
}

// Create loading shimmer placeholder
function createLoadingShimmer() {
  const shimmer = document.createElement('span');
  shimmer.setAttribute('data-twitter-flag-shimmer', 'true');
  shimmer.style.display = 'inline-block';
  shimmer.style.width = '20px';
  shimmer.style.height = '16px';
  shimmer.style.marginLeft = '4px';
  shimmer.style.marginRight = '4px';
  shimmer.style.verticalAlign = 'middle';
  shimmer.style.borderRadius = '2px';
  shimmer.style.background = 'linear-gradient(90deg, rgba(113, 118, 123, 0.2) 25%, rgba(113, 118, 123, 0.4) 50%, rgba(113, 118, 123, 0.2) 75%)';
  shimmer.style.backgroundSize = '200% 100%';
  shimmer.style.animation = 'shimmer 1.5s infinite';
  
  // Add animation keyframes if not already added
  if (!document.getElementById('twitter-flag-shimmer-style')) {
    const style = document.createElement('style');
    style.id = 'twitter-flag-shimmer-style';
    style.textContent = `
      @keyframes shimmer {
        0% {
          background-position: -200% 0;
        }
        100% {
          background-position: 200% 0;
        }
      }
    `;
    document.head.appendChild(style);
  }
  
  return shimmer;
}

// Create a hide button to re-hide the post
function addHideButton(tweetContainer, messageContainer, children) {
  // Check if hide button already exists
  if (tweetContainer.querySelector('[data-twitter-hide-btn]')) return;

  const hideButton = document.createElement('button');
  hideButton.textContent = 'Hide';
  hideButton.setAttribute('data-twitter-hide-btn', 'true');
  hideButton.style.cssText = 'background-color: transparent; border: 1px solid rgb(83, 100, 113); color: rgb(83, 100, 113); font-weight: 600; border-radius: 9999px; padding: 2px 10px; cursor: pointer; font-size: 12px; margin-left: 8px; transition: all 0.2s;';
  
  hideButton.onmouseover = () => {
    hideButton.style.backgroundColor = 'rgba(239, 68, 68, 0.1)';
    hideButton.style.color = 'rgb(239, 68, 68)';
    hideButton.style.borderColor = 'rgb(239, 68, 68)';
  };
  hideButton.onmouseout = () => {
    hideButton.style.backgroundColor = 'transparent';
    hideButton.style.color = 'rgb(83, 100, 113)';
    hideButton.style.borderColor = 'rgb(83, 100, 113)';
  };
  
  hideButton.onclick = (e) => {
    e.stopPropagation();
    messageContainer.style.display = 'flex';
    children.forEach(child => child.style.display = 'none');
    hideButton.remove();
  };

  // Find a good place to insert - ideally near the timestamp or "More" button
  // We'll look for the User-Name container first
  const userNameContainer = tweetContainer.querySelector('[data-testid="User-Name"]');
  if (userNameContainer) {
    // Try to append to the end of the user name row
    userNameContainer.appendChild(hideButton);
  } else {
    // Fallback - just prepend to the first visible child
    const firstChild = children.find(c => c.style.display !== 'none');
    if (firstChild) {
      firstChild.insertBefore(hideButton, firstChild.firstChild);
    }
  }
}

// Create blacklist toggle button
function createBlacklistButton(screenName, location) {
  const btn = document.createElement('button');
  btn.innerHTML = '+'; // Simple plus for now, could be an SVG
  btn.title = `Add ${location} to blacklist`;
  btn.style.cssText = 'background-color: transparent; border: 1px solid rgba(113, 118, 123, 0.5); color: rgb(113, 118, 123); width: 18px; height: 18px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; margin-left: 6px; font-size: 12px; line-height: 1; vertical-align: middle; padding: 0; transition: all 0.2s;';
  
  btn.onmouseover = () => {
    btn.style.backgroundColor = 'rgba(244, 33, 46, 0.1)';
    btn.style.color = 'rgb(244, 33, 46)';
    btn.style.borderColor = 'rgb(244, 33, 46)';
  };
  
  btn.onmouseout = () => {
    btn.style.backgroundColor = 'transparent';
    btn.style.color = 'rgb(113, 118, 123)';
    btn.style.borderColor = 'rgba(113, 118, 123, 0.5)';
  };
  
  btn.onclick = (e) => {
    e.stopPropagation();
    e.preventDefault();
    
    // Confirm blocking
    if (confirm(`Block all posts from ${location}?`)) {
      // Add to blacklist
      chrome.storage.local.get(BLACKLIST_KEY, (result) => {
        const currentList = result[BLACKLIST_KEY] || [];
        if (!currentList.includes(location)) {
          const newList = [...currentList, location];
          chrome.storage.local.set({ [BLACKLIST_KEY]: newList }, () => {
            console.log(`Added ${location} to blacklist`);
            // Trigger reprocessing will happen via storage listener
          });
        }
      });
    }
  };
  
  return btn;
}


// Function to add flag to username element
async function addFlagToUsername(usernameElement, screenName) {
  // Check if flag already added
  if (usernameElement.dataset.flagAdded === 'true') {
    return;
  }

  // Check if this username is already being processed (prevent duplicate API calls)
  if (processingUsernames.has(screenName)) {
    // Wait a bit and check if flag was added by the other process
    await new Promise(resolve => setTimeout(resolve, 500));
    if (usernameElement.dataset.flagAdded === 'true') {
      return;
    }
    // If still not added, mark this container as waiting
    usernameElement.dataset.flagAdded = 'waiting';
    return;
  }

  // Mark as processing to avoid duplicate requests
  usernameElement.dataset.flagAdded = 'processing';
  processingUsernames.add(screenName);
  
  // Find User-Name container for shimmer placement
  const userNameContainer = usernameElement.querySelector('[data-testid="UserName"], [data-testid="User-Name"]');
  
  // Create and insert loading shimmer
  const shimmerSpan = createLoadingShimmer();
  let shimmerInserted = false;
  
  if (userNameContainer) {
    // Try to insert shimmer before handle section (same place flag will go)
    const handleSection = findHandleSection(userNameContainer, screenName);
    if (handleSection && handleSection.parentNode) {
      try {
        handleSection.parentNode.insertBefore(shimmerSpan, handleSection);
        shimmerInserted = true;
      } catch (e) {
        // Fallback: insert at end of container
        try {
          userNameContainer.appendChild(shimmerSpan);
          shimmerInserted = true;
        } catch (e2) {
          console.log('Failed to insert shimmer');
        }
      }
    } else {
      // Fallback: insert at end of container
      try {
        userNameContainer.appendChild(shimmerSpan);
        shimmerInserted = true;
      } catch (e) {
        console.log('Failed to insert shimmer');
      }
    }
  }
  
  try {
    console.log(`Processing flag for ${screenName}...`);

    // Get location
    const location = await getUserLocation(screenName);
    console.log(`Location for ${screenName}:`, location);
    
    // Remove shimmer
    if (shimmerInserted && shimmerSpan.parentNode) {
      shimmerSpan.remove();
    }
    
    if (!location) {
      console.log(`No location found for ${screenName}, marking as failed`);
      usernameElement.dataset.flagAdded = 'failed';
      return;
    }

    // Check against blacklist
    const locationLower = location.toLowerCase();
    const isBlocked = blockedCountries.some(country =>
      locationLower.includes(country.toLowerCase())
    );

    if (isBlocked) {
      console.log(`Blocking post from ${screenName} (${location})`);
      
      // Find the tweet container
      const tweetContainer = usernameElement.closest('article[data-testid="tweet"]');
      if (tweetContainer) {
        // Check if already blocked to prevent double-hiding (nested overlays)
        if (tweetContainer.hasAttribute('data-twitter-blocked')) {
            console.log('Tweet already blocked, skipping duplicate block');
            usernameElement.dataset.flagAdded = 'blocked';
            return;
        }

        // Hide children instead of clearing
        const children = Array.from(tweetContainer.children);
        children.forEach(child => child.style.display = 'none');
        
        const messageContainer = document.createElement('div');
        messageContainer.style.cssText = 'padding: 20px 16px; display: flex; align-items: center; justify-content: center; gap: 12px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background-color: transparent; border-bottom: 1px solid rgb(47, 51, 54); color: rgb(113, 118, 123); font-size: 15px;';
        
        const textSpan = document.createElement('span');
        textSpan.textContent = `Post hidden because account is from ${location}`;
        
        const showButton = document.createElement('button');
        showButton.textContent = 'Show';
        showButton.style.cssText = 'background-color: transparent; border: 1px solid rgb(83, 100, 113); color: rgb(29, 155, 240); font-weight: 700; border-radius: 9999px; padding: 4px 12px; cursor: pointer; font-size: 14px; transition: background-color 0.2s;';
        
        showButton.onmouseover = () => showButton.style.backgroundColor = 'rgba(29, 155, 240, 0.1)';
        showButton.onmouseout = () => showButton.style.backgroundColor = 'transparent';
        
        showButton.onclick = (e) => {
            e.stopPropagation(); // Prevent clicking the tweet
            messageContainer.style.display = 'none'; // Don't remove, just hide
            children.forEach(child => child.style.display = '');
            
            // Add a "Hide" button to the tweet header if not already present
            addHideButton(tweetContainer, messageContainer, children);
        };
        
        messageContainer.appendChild(textSpan);
        messageContainer.appendChild(showButton);
        
        tweetContainer.appendChild(messageContainer);
        
        // Mark as blocked to avoid re-processing
        usernameElement.dataset.flagAdded = 'blocked';
        tweetContainer.setAttribute('data-twitter-blocked', 'true');
        
        // Remove shimmer if it was inserted
        if (shimmerInserted && shimmerSpan.parentNode) {
          shimmerSpan.remove();
        }
        return;
      } else {
        console.log('Could not find tweet container to hide');
      }
    }

  // Get flag emoji
  const flag = getCountryFlag(location);
  if (!flag) {
    console.log(`No flag found for location: ${location}`);
    // Shimmer already removed above, but ensure it's gone
    if (shimmerInserted && shimmerSpan.parentNode) {
      shimmerSpan.remove();
    }
    usernameElement.dataset.flagAdded = 'failed';
    return;
  }
  
  console.log(`Found flag ${flag} for ${screenName} (${location})`);

  // Find the username link - try multiple strategies
  // Priority: Find the @username link, not the display name link
  let usernameLink = null;
  
  // Find the User-Name container (reuse from above if available, otherwise find it)
  const containerForLink = userNameContainer || usernameElement.querySelector('[data-testid="UserName"], [data-testid="User-Name"]');
  
  // Strategy 1: Find link with @username text content (most reliable - this is the actual handle)
  if (containerForLink) {
    const containerLinks = containerForLink.querySelectorAll('a[href^="/"]');
    for (const link of containerLinks) {
      const text = link.textContent?.trim();
      const href = link.getAttribute('href');
      const match = href.match(/^\/([^\/\?]+)/);
      
      // Prioritize links that have @username as text
      if (match && match[1] === screenName) {
        if (text === `@${screenName}` || text === screenName) {
          usernameLink = link;
          break;
        }
      }
    }
  }
  
  // Strategy 2: Find any link with @username text in UserName container
  if (!usernameLink && containerForLink) {
    const containerLinks = containerForLink.querySelectorAll('a[href^="/"]');
    for (const link of containerLinks) {
      const text = link.textContent?.trim();
      if (text === `@${screenName}`) {
        usernameLink = link;
        break;
      }
    }
  }
  
  // Strategy 3: Find link with exact matching href that has @username text anywhere in element
  if (!usernameLink) {
    const links = usernameElement.querySelectorAll('a[href^="/"]');
    for (const link of links) {
      const href = link.getAttribute('href');
      const text = link.textContent?.trim();
      if ((href === `/${screenName}` || href.startsWith(`/${screenName}?`)) && 
          (text === `@${screenName}` || text === screenName)) {
        usernameLink = link;
        break;
      }
    }
  }
  
  // Strategy 4: Fallback to any matching href (but prefer ones not in display name area)
  if (!usernameLink) {
    const links = usernameElement.querySelectorAll('a[href^="/"]');
    for (const link of links) {
      const href = link.getAttribute('href');
      const match = href.match(/^\/([^\/\?]+)/);
      if (match && match[1] === screenName) {
        // Skip if this looks like a display name link (has verification badge nearby)
        const hasVerificationBadge = link.closest('[data-testid="User-Name"]')?.querySelector('[data-testid="icon-verified"]');
        if (!hasVerificationBadge || link.textContent?.trim() === `@${screenName}`) {
          usernameLink = link;
          break;
        }
      }
    }
  }

  if (!usernameLink) {
    console.error(`Could not find username link for ${screenName}`);
    console.error('Available links in container:', Array.from(usernameElement.querySelectorAll('a[href^="/"]')).map(l => ({
      href: l.getAttribute('href'),
      text: l.textContent?.trim()
    })));
    // Remove shimmer on error
    if (shimmerInserted && shimmerSpan.parentNode) {
      shimmerSpan.remove();
    }
    usernameElement.dataset.flagAdded = 'failed';
    return;
  }
  
  console.log(`Found username link for ${screenName}:`, usernameLink.href, usernameLink.textContent?.trim());

  // Check if flag already exists (check in the entire container, not just parent)
  const existingFlag = usernameElement.querySelector('[data-twitter-flag]');
  if (existingFlag) {
    // Remove shimmer if flag already exists
    if (shimmerInserted && shimmerSpan.parentNode) {
      shimmerSpan.remove();
    }
    usernameElement.dataset.flagAdded = 'true';
    return;
  }

  // Add flag emoji - place it next to verification badge, before @ handle
  const flagSpan = document.createElement('span');
  flagSpan.textContent = ` ${flag}`;
  flagSpan.setAttribute('data-twitter-flag', 'true');
  flagSpan.style.marginLeft = '4px';
  flagSpan.style.marginRight = '4px';
  flagSpan.style.display = 'inline';
  flagSpan.style.color = 'inherit';
  flagSpan.style.verticalAlign = 'middle';
  
  // Use userNameContainer found above, or find it if not found
  const containerForFlag = userNameContainer || usernameElement.querySelector('[data-testid="UserName"], [data-testid="User-Name"]');
  
  if (!containerForFlag) {
    console.error(`Could not find UserName container for ${screenName}`);
    // Remove shimmer on error
    if (shimmerInserted && shimmerSpan.parentNode) {
      shimmerSpan.remove();
    }
    usernameElement.dataset.flagAdded = 'failed';
    return;
  }
  
  // Find the verification badge (SVG with data-testid="icon-verified")
  const verificationBadge = containerForFlag.querySelector('[data-testid="icon-verified"]');
  
  // Find the handle section - the div that contains the @username link
  // The structure is: User-Name > div (display name) > div (handle section with @username)
  const handleSection = findHandleSection(containerForFlag, screenName);

  let inserted = false;
  
  // Strategy 1: Insert right before the handle section div (which contains @username)
  // The handle section is a direct child of User-Name container
  if (handleSection && handleSection.parentNode === containerForFlag) {
    try {
      containerForFlag.insertBefore(flagSpan, handleSection);
      inserted = true;
      console.log(`✓ Inserted flag before handle section for ${screenName}`);
    } catch (e) {
      console.log('Failed to insert before handle section:', e);
    }
  }
  
  // Strategy 2: Find the handle section's parent and insert before it
  if (!inserted && handleSection && handleSection.parentNode) {
    try {
      // Insert before the handle section's parent (if it's not User-Name)
      const handleParent = handleSection.parentNode;
      if (handleParent !== containerForFlag && handleParent.parentNode) {
        handleParent.parentNode.insertBefore(flagSpan, handleParent);
        inserted = true;
        console.log(`✓ Inserted flag before handle parent for ${screenName}`);
      } else if (handleParent === containerForFlag) {
        // Handle section is direct child, insert before it
        containerForFlag.insertBefore(flagSpan, handleSection);
        inserted = true;
        console.log(`✓ Inserted flag before handle section (direct child) for ${screenName}`);
      }
    } catch (e) {
      console.log('Failed to insert before handle parent:', e);
    }
  }
  
  // Strategy 3: Find display name container and insert after it, before handle section
  if (!inserted && handleSection) {
    try {
      // Find the display name link (first link)
      const displayNameLink = containerForFlag.querySelector('a[href^="/"]');
      if (displayNameLink) {
        // Find the div that contains the display name link
        const displayNameContainer = displayNameLink.closest('div');
        if (displayNameContainer && displayNameContainer.parentNode) {
          // Check if handle section is a sibling
          if (displayNameContainer.parentNode === handleSection.parentNode) {
            displayNameContainer.parentNode.insertBefore(flagSpan, handleSection);
            inserted = true;
            console.log(`✓ Inserted flag between display name and handle (siblings) for ${screenName}`);
          } else {
            // Try inserting after display name container
            displayNameContainer.parentNode.insertBefore(flagSpan, displayNameContainer.nextSibling);
            inserted = true;
            console.log(`✓ Inserted flag after display name container for ${screenName}`);
          }
        }
      }
    } catch (e) {
      console.log('Failed to insert after display name:', e);
    }
  }
  
  // Strategy 4: Insert at the end of User-Name container (fallback)
  if (!inserted) {
    try {
      containerForFlag.appendChild(flagSpan);
      inserted = true;
      console.log(`✓ Inserted flag at end of UserName container for ${screenName}`);
    } catch (e) {
      console.error('Failed to append flag to User-Name container:', e);
    }
  }
  
    if (inserted) {
      // Mark as processed
      usernameElement.dataset.flagAdded = 'true';
      console.log(`✓ Successfully added flag ${flag} for ${screenName} (${location})`);

      // Insert Blacklist Button
      try {
        const insertedFlag = usernameElement.querySelector('[data-twitter-flag]');
        if (insertedFlag && insertedFlag.parentNode) {
            const blacklistBtn = createBlacklistButton(screenName, location);
            insertedFlag.parentNode.insertBefore(blacklistBtn, insertedFlag.nextSibling);
        }
      } catch (e) {
          console.error('Error adding blacklist button:', e);
      }
      
      // Also mark any other containers waiting for this username
      const waitingContainers = document.querySelectorAll(`[data-flag-added="waiting"]`);
      waitingContainers.forEach(container => {
        const waitingUsername = extractUsername(container);
        if (waitingUsername === screenName) {
          // Try to add flag to this container too
          addFlagToUsername(container, screenName).catch(() => {});
        }
      });
    } else {
      console.error(`✗ Failed to insert flag for ${screenName} - tried all strategies`);
      console.error('Username link:', usernameLink);
      console.error('Parent structure:', usernameLink.parentNode);
      // Remove shimmer on failure
      if (shimmerInserted && shimmerSpan.parentNode) {
        shimmerSpan.remove();
      }
      usernameElement.dataset.flagAdded = 'failed';
    }
  } catch (error) {
    console.error(`Error processing flag for ${screenName}:`, error);
    // Remove shimmer on error
    if (shimmerInserted && shimmerSpan.parentNode) {
      shimmerSpan.remove();
    }
    usernameElement.dataset.flagAdded = 'failed';
  } finally {
    // Remove from processing set
    processingUsernames.delete(screenName);
  }
}

// Function to remove all flags (when extension is disabled)
function removeAllFlags() {
  const flags = document.querySelectorAll('[data-twitter-flag]');
  flags.forEach(flag => flag.remove());
  
  // Also remove any loading shimmers
  const shimmers = document.querySelectorAll('[data-twitter-flag-shimmer]');
  shimmers.forEach(shimmer => shimmer.remove());
  
  // Reset flag added markers
  const containers = document.querySelectorAll('[data-flag-added]');
  containers.forEach(container => {
    delete container.dataset.flagAdded;
  });
  
  console.log('Removed all flags');
}

// Function to process all username elements on the page
async function processUsernames() {
  // Check if extension is enabled
  if (!extensionEnabled) {
    return;
  }
  
  // Find all tweet/article containers and user cells
  const containers = document.querySelectorAll('article[data-testid="tweet"], [data-testid="UserCell"], [data-testid="User-Names"], [data-testid="User-Name"]');
  
  console.log(`Processing ${containers.length} containers for usernames`);
  
  let foundCount = 0;
  let processedCount = 0;
  let skippedCount = 0;
  
  for (const container of containers) {
    // Skip if already processed or failed
    const status = container.dataset.flagAdded;
    if (status && status !== 'failed') {
      skippedCount++;
      continue;
    }

    // Skip if already observing
    if (container.dataset.observed === 'true') {
      continue;
    }

    // Check if it has a username structure before observing (optimization)
    // We don't extract the full username yet to save performance
    const hasUserName = container.querySelector('[data-testid="UserName"], [data-testid="User-Name"]');
    
    if (hasUserName || container.tagName === 'ARTICLE') {
      foundCount++;
      processedCount++;
      
      // Mark as observed
      container.dataset.observed = 'true';
      
      // Add to visibility observer
      visibilityObserver.observe(container);
    }
  }
  
  if (foundCount > 0) {
    console.log(`Found ${foundCount} usernames, processing ${processedCount} new ones, skipped ${skippedCount} already processed`);
  } else {
    console.log('No usernames found in containers');
  }
}

// Initialize observer for dynamically loaded content
function initObserver() {
  if (observer) {
    observer.disconnect();
  }

  observer = new MutationObserver((mutations) => {
    // Don't process if extension is disabled
    if (!extensionEnabled) {
      return;
    }
    
    let shouldProcess = false;
    for (const mutation of mutations) {
      if (mutation.addedNodes.length > 0) {
        shouldProcess = true;
        break;
      }
    }
    
    if (shouldProcess) {
      // Debounce processing
      setTimeout(processUsernames, 500);
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true
  });
}

// Main initialization
async function init() {
  console.log('Twitter Location Flag extension initialized');
  
  // Load enabled state first
  await loadEnabledState();
  
  // Load persistent cache
  await loadCache();
  
  // Only proceed if extension is enabled
  if (!extensionEnabled) {
    console.log('Extension is disabled');
    return;
  }
  
  // Inject page script
  injectPageScript();
  
  // Wait a bit for page to fully load
  setTimeout(() => {
    processUsernames();
  }, 2000);
  
  // Set up observer for new content
  initObserver();
  
  // Re-process on navigation (Twitter uses SPA)
  let lastUrl = location.href;
  new MutationObserver(() => {
    const url = location.href;
    if (url !== lastUrl) {
      lastUrl = url;
      console.log('Page navigation detected, reprocessing usernames');
      setTimeout(processUsernames, 2000);
    }
  }).observe(document, { subtree: true, childList: true });
  
  // Save cache periodically
  setInterval(saveCache, 30000); // Save every 30 seconds
}

// Wait for page to load
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

