// Popup script for extension toggle
const TOGGLE_KEY = 'extension_enabled';
const DEFAULT_ENABLED = true;

// Get toggle element
const toggleSwitch = document.getElementById('toggleSwitch');
const status = document.getElementById('status');

// Load current state
chrome.storage.local.get([TOGGLE_KEY], (result) => {
  const isEnabled = result[TOGGLE_KEY] !== undefined ? result[TOGGLE_KEY] : DEFAULT_ENABLED;
  updateToggle(isEnabled);
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

