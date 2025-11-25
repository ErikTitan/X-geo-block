// Popup script for extension toggle
const TOGGLE_KEY = 'extension_enabled';
const DEFAULT_ENABLED = true;

// Get toggle element
const toggleSwitch = document.getElementById('toggleSwitch');
const status = document.getElementById('status');
const blacklistInput = document.getElementById('blacklist');
const saveButton = document.getElementById('saveButton');
const saveStatus = document.getElementById('saveStatus');
const cacheStats = document.getElementById('cacheStats');
const clearCacheButton = document.getElementById('clearCacheButton');

const BLACKLIST_KEY = 'blocked_countries';
const CACHE_KEY = 'twitter_location_cache';

// Load current state
chrome.storage.local.get([TOGGLE_KEY, BLACKLIST_KEY, CACHE_KEY], (result) => {
  const isEnabled = result[TOGGLE_KEY] !== undefined ? result[TOGGLE_KEY] : DEFAULT_ENABLED;
  updateToggle(isEnabled);

  const blockedCountries = result[BLACKLIST_KEY] || [];
  blacklistInput.value = blockedCountries.join('\n');

  // Cache stats
  const cache = result[CACHE_KEY] || {};
  const cacheSize = Object.keys(cache).length;
  
  // Calculate size in KB/MB
  const jsonString = JSON.stringify(cache);
  const bytes = new Blob([jsonString]).size;
  const sizeStr = bytes > 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(2)} MB`
    : `${(bytes / 1024).toFixed(2)} KB`;
    
  cacheStats.textContent = `${cacheSize} users cached (${sizeStr})`;
});

// Clear cache handler
clearCacheButton.addEventListener('click', () => {
  if (confirm('Are you sure you want to clear the location cache?')) {
    chrome.storage.local.remove(CACHE_KEY, () => {
      cacheStats.textContent = '0 users cached (0.00 KB)';
      // Notify content script to clear its in-memory cache too
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) {
          chrome.tabs.sendMessage(tabs[0].id, { type: 'clearCache' });
        }
      });
    });
  }
});

// Save blacklist handler
saveButton.addEventListener('click', () => {
  const countries = blacklistInput.value
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);
  
  chrome.storage.local.set({ [BLACKLIST_KEY]: countries }, () => {
    // Show saved status
    saveStatus.classList.add('visible');
    setTimeout(() => {
      saveStatus.classList.remove('visible');
    }, 2000);

    // Notify content script to update blacklist (optional, as content script can listen to storage changes)
  });
});

// Toggle click handler
toggleSwitch.addEventListener('click', () => {
  chrome.storage.local.get([TOGGLE_KEY], (result) => {
    const currentState = result[TOGGLE_KEY] !== undefined ? result[TOGGLE_KEY] : DEFAULT_ENABLED;
    const newState = !currentState;
    
    chrome.storage.local.set({ [TOGGLE_KEY]: newState }, () => {
      updateToggle(newState);
      
      // Notify content script to update
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) {
          chrome.tabs.sendMessage(tabs[0].id, {
            type: 'extensionToggle',
            enabled: newState
          }).catch(() => {
            // Tab might not have content script loaded yet, that's okay
          });
        }
      });
    });
  });
});

function updateToggle(isEnabled) {
  if (isEnabled) {
    toggleSwitch.classList.add('enabled');
    status.textContent = 'Extension is enabled';
    status.style.color = '#1d9bf0';
  } else {
    toggleSwitch.classList.remove('enabled');
    status.textContent = 'Extension is disabled';
    status.style.color = '#536471';
  }
}

