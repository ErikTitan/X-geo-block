// Cache for user locations - persistent storage
let locationCache = new Map();
const CACHE_KEY = 'twitter_location_cache';
const CACHE_EXPIRY_DAYS = 30; // Cache for 30 days

// Rate limiting
const requestQueue = [];
let isProcessingQueue = false;
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 2000; // 2 seconds between requests (increased to avoid rate limits)
const MAX_CONCURRENT_REQUESTS = 2; // Reduced concurrent requests
let activeRequests = 0;
let rateLimitResetTime = 0; // Unix timestamp when rate limit resets

// Observer for dynamically loaded content
let observer = null;

// Extension enabled state
let extensionEnabled = true;
const TOGGLE_KEY = 'extension_enabled';
const DEFAULT_ENABLED = true;

// Load enabled state
async function loadEnabledState() {
  try {
    const result = await chrome.storage.local.get([TOGGLE_KEY]);
    extensionEnabled = result[TOGGLE_KEY] !== undefined ? result[TOGGLE_KEY] : DEFAULT_ENABLED;
    console.log('Extension enabled:', extensionEnabled);
  } catch (error) {
    console.error('Error loading enabled state:', error);
    extensionEnabled = DEFAULT_ENABLED;
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
  }
});

// Load cache from persistent storage
async function loadCache() {
  try {
    const result = await chrome.storage.local.get(CACHE_KEY);
    if (result[CACHE_KEY]) {
      const cached = result[CACHE_KEY];
      const now = Date.now();
      
      // Filter out expired entries and null entries (allow retry)
      for (const [username, data] of Object.entries(cached)) {
        if (data.expiry && data.expiry > now && data.location !== null) {
          locationCache.set(username, data.location);
        }
      }
      console.log(`Loaded ${locationCache.size} cached locations (excluding null entries)`);
    }
  } catch (error) {
    console.error('Error loading cache:', error);
  }
}

// Save cache to persistent storage
async function saveCache() {
  try {
    const cacheObj = {};
    const now = Date.now();
    const expiry = now + (CACHE_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
    
    for (const [username, location] of locationCache.entries()) {
      cacheObj[username] = {
        location: location,
        expiry: expiry,
        cachedAt: now
      };
    }
    
    await chrome.storage.local.set({ [CACHE_KEY]: cacheObj });
  } catch (error) {
    console.error('Error saving cache:', error);
  }
}

// Save a single entry to cache
async function saveCacheEntry(username, location) {
  locationCache.set(username, location);
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
    
    // Wait if needed to respect rate limit
    if (timeSinceLastRequest < MIN_REQUEST_INTERVAL) {
      await new Promise(resolve => setTimeout(resolve, MIN_REQUEST_INTERVAL - timeSinceLastRequest));
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
        
        // Cache the result (even if null to avoid repeated failed requests)
        saveCacheEntry(screenName, location || null);
        
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
      saveCacheEntry(screenName, null); // Cache null to avoid retrying immediately
      resolve(null);
    }, 10000);
  });
}

// Function to query Twitter GraphQL API for user location (with rate limiting)
async function getUserLocation(screenName) {
  // Check cache first
  if (locationCache.has(screenName)) {
    const cached = locationCache.get(screenName);
    // Don't return cached null - retry if it was null before (might have been rate limited)
    if (cached !== null) {
      console.log(`Using cached location for ${screenName}: ${cached}`);
      return cached;
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

// Function to add flag to username element
async function addFlagToUsername(usernameElement, screenName) {
  // Check if flag already added
  if (usernameElement.dataset.flagAdded === 'true') {
    return;
  }

  // Mark as processing to avoid duplicate requests
  usernameElement.dataset.flagAdded = 'processing';
  console.log(`Processing flag for ${screenName}...`);

  // Get location
  const location = await getUserLocation(screenName);
  console.log(`Location for ${screenName}:`, location);
  if (!location) {
    console.log(`No location found for ${screenName}, marking as failed`);
    usernameElement.dataset.flagAdded = 'failed';
    return;
  }

  // Get flag emoji
  const flag = getCountryFlag(location);
  if (!flag) {
    console.log(`No flag found for location: ${location}`);
    usernameElement.dataset.flagAdded = 'failed';
    return;
  }
  
  console.log(`Found flag ${flag} for ${screenName} (${location})`);

  // Find the username link - try multiple strategies
  // Priority: Find the @username link, not the display name link
  let usernameLink = null;
  
  // Strategy 1: Find link with @username text content (most reliable - this is the actual handle)
  const userNameContainer = usernameElement.querySelector('[data-testid="UserName"], [data-testid="User-Name"]');
  if (userNameContainer) {
    const containerLinks = userNameContainer.querySelectorAll('a[href^="/"]');
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
  if (!usernameLink && userNameContainer) {
    const containerLinks = userNameContainer.querySelectorAll('a[href^="/"]');
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
    usernameElement.dataset.flagAdded = 'failed';
    return;
  }
  
  console.log(`Found username link for ${screenName}:`, usernameLink.href, usernameLink.textContent?.trim());

  // Check if flag already exists (check in the entire container, not just parent)
  const existingFlag = usernameElement.querySelector('[data-twitter-flag]');
  if (existingFlag) {
    usernameElement.dataset.flagAdded = 'true';
    return;
  }

  // Add flag emoji after username link
  const flagSpan = document.createElement('span');
  flagSpan.textContent = ` ${flag}`;
  flagSpan.setAttribute('data-twitter-flag', 'true');
  flagSpan.style.marginLeft = '4px';
  flagSpan.style.display = 'inline';
  flagSpan.style.color = 'inherit'; // Inherit color from parent
  
  // Try to insert flag after username link
  // Twitter wraps the @username link in a div, so we need to insert after that div
  let inserted = false;
  
  // Strategy 1: Insert after the parent div of the @username link
  // The @username link is typically in a div that comes after the display name
  if (usernameLink.parentNode) {
    try {
      // Insert right after the parent div
      usernameLink.parentNode.parentNode?.insertBefore(flagSpan, usernameLink.parentNode.nextSibling);
      if (flagSpan.parentNode) {
        inserted = true;
      }
    } catch (e) {
      console.log('Failed to insert after parent div:', e);
    }
  }
  
  // Strategy 2: Insert right after the link in its immediate parent
  if (!inserted && usernameLink.parentNode) {
    try {
      usernameLink.parentNode.insertBefore(flagSpan, usernameLink.nextSibling);
      if (flagSpan.parentNode) {
        inserted = true;
      }
    } catch (e) {
      console.log('Failed to insert after link:', e);
    }
  }
  
  // Strategy 3: Find the container div that holds both name and handle, insert after handle div
  if (!inserted) {
    const userNameContainer = usernameLink.closest('[data-testid="UserName"], [data-testid="User-Name"]');
    if (userNameContainer) {
      // Find the div that contains the @username link
      const handleDiv = usernameLink.closest('div');
      if (handleDiv && handleDiv.parentNode) {
        try {
          handleDiv.parentNode.insertBefore(flagSpan, handleDiv.nextSibling);
          if (flagSpan.parentNode) {
            inserted = true;
          }
        } catch (e) {
          console.log('Failed to insert after handle div:', e);
        }
      }
    }
  }
  
  // Strategy 4: Insert at end of User-Name container (fallback)
  if (!inserted) {
    const userNameContainer = usernameLink.closest('[data-testid="UserName"], [data-testid="User-Name"]');
    if (userNameContainer) {
      try {
        userNameContainer.appendChild(flagSpan);
        inserted = true;
      } catch (e) {
        console.log('Failed to append to UserName container:', e);
      }
    }
  }
  
  // Strategy 5: Append to the link itself (last resort)
  if (!inserted) {
    try {
      usernameLink.appendChild(flagSpan);
      inserted = true;
    } catch (e) {
      console.error('Failed to append flag to link:', e);
    }
  }
  
  if (inserted) {
    // Mark as processed
    usernameElement.dataset.flagAdded = 'true';
    console.log(`✓ Successfully added flag ${flag} for ${screenName} (${location})`);
  } else {
    console.error(`✗ Failed to insert flag for ${screenName} - tried all strategies`);
    console.error('Username link:', usernameLink);
    console.error('Parent structure:', usernameLink.parentNode);
    usernameElement.dataset.flagAdded = 'failed';
  }
}

// Function to remove all flags (when extension is disabled)
function removeAllFlags() {
  const flags = document.querySelectorAll('[data-twitter-flag]');
  flags.forEach(flag => flag.remove());
  
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
    const screenName = extractUsername(container);
    if (screenName) {
      foundCount++;
      const status = container.dataset.flagAdded;
      if (!status || status === 'failed') {
        processedCount++;
        // Process in parallel but limit concurrency
        addFlagToUsername(container, screenName).catch(err => {
          console.error(`Error processing ${screenName}:`, err);
          container.dataset.flagAdded = 'failed';
        });
      } else {
        skippedCount++;
      }
    } else {
      // Debug: log containers that don't have usernames
      const hasUserName = container.querySelector('[data-testid="UserName"], [data-testid="User-Name"]');
      if (hasUserName) {
        console.log('Found UserName container but no username extracted');
      }
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

