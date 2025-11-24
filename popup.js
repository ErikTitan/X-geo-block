// Popup script for extension toggle
const TOGGLE_KEY = 'extension_enabled';
const DEFAULT_ENABLED = true;

// Get toggle element
const toggleSwitch = document.getElementById('toggleSwitch');
const status = document.getElementById('status');
const blacklistInput = document.getElementById('blacklist');
const saveButton = document.getElementById('saveButton');
const saveStatus = document.getElementById('saveStatus');

const BLACKLIST_KEY = 'blocked_countries';

// Load current state
chrome.storage.local.get([TOGGLE_KEY, BLACKLIST_KEY], (result) => {
  const isEnabled = result[TOGGLE_KEY] !== undefined ? result[TOGGLE_KEY] : DEFAULT_ENABLED;
  updateToggle(isEnabled);

  const blockedCountries = result[BLACKLIST_KEY] || [];
  blacklistInput.value = blockedCountries.join('\n');
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

