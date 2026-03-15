<div align="center">

# Auto-McGraw (Smartbook)

<img src="assets/icon.png" alt="Auto-McGraw Logo" width="200">

[![Release](https://img.shields.io/github/v/release/GooglyBlox/auto-mcgraw?include_prereleases&style=flat-square&cache=1)](https://github.com/GooglyBlox/auto-mcgraw/releases)
[![License](https://img.shields.io/github/license/GooglyBlox/auto-mcgraw?style=flat-square&cache=1)](LICENSE)
[![Issues](https://img.shields.io/github/issues/GooglyBlox/auto-mcgraw?style=flat-square&cache=1)](https://github.com/GooglyBlox/auto-mcgraw/issues)

*Automate your McGraw Hill Smartbook homework with AI integration (ChatGPT, Gemini & DeepSeek)*

[Installation](#installation) • [Usage](#usage) • [Settings](#settings) • [Issues](#issues)

</div>

---

## Fork Notice (`dev` branch)

This repository is a **fork** of the original Auto-McGraw project by `GooglyBlox`.
The sections below keep the original usage documentation, and this section tracks major fork-specific differences on `dev`.

As of **March 14, 2026**, `dev` is **24 commits ahead** and **17 commits behind** `upstream/main`.

### Current major changes from `upstream/main`

- Expanded EZTO automation support (`https://ezto.mheducation.com/*`) with a dedicated script (`content-scripts/ezto-mheducation.js`), including full click-and-drag handling, retry/verification logic, manual-assist pause/resume, improved activity-page answer reliability, and improved end-of-quiz detection.
- Expanded SmartBook question support in `content-scripts/mheducation.js` with ordering automation and matching automation/fallback handling.
- Hardened reliability and recovery across flows with request IDs, watchdog retries, transition/commit guards, and manual recovery pause logic to reduce stalls and recover safely.
- Hardened chatbot tab routing/recovery logic, including improved DeepSeek support for both `chat.deepseek.com` and `deepseek.chat` in background/content-script/manifest handling.
- Added HTML selector-reference snapshots used for extraction/selector maintenance (`*_html_reference.html` and `mheducation_html_references/*`) plus `AGENTS.md` mappings for this workflow.

---

## Compatibility Notice

**⚠️ MacOS Users:** This extension may not work properly on MacOS due to platform-specific differences in Chrome extension behavior and system interactions. For the best experience, we recommend using this extension on Windows or Linux systems.

---

## Installation

1. Download the latest zip from the [releases page](https://github.com/GooglyBlox/auto-mcgraw/releases)
2. Extract the zip file to a folder
3. Open Chrome and go to `chrome://extensions/`
4. Enable "Developer mode" in the top right
5. Click "Load unpacked" and select the extracted folder

## Usage

1. Log into your McGraw Hill account and open a Smartbook assignment
2. Log into one of the supported AI assistants in another tab:
   - [ChatGPT](https://chatgpt.com)
   - [Gemini](https://gemini.google.com)
   - [DeepSeek](https://chat.deepseek.com)
3. Click the "Ask [AI Model]" button that appears in your Smartbook header
4. Click "OK" when prompted to begin automation
5. Watch as the extension:
   - Sends questions to your chosen AI assistant
   - Processes the responses
   - Automatically fills in answers
   - Handles multiple choice, true/false, fill-in-the-blank, ordering, and matching questions
      - **Note about matching questions:** Matching questions now attempt full automation. If a strict, reliable match cannot be completed, the extension will show AI-suggested matches in an alert, pause, and let you finish manually before resuming on the next question.
   - Navigates through forced learning sections when needed

Click "Stop Automation" at any time to pause the process.

## Settings

Click the settings icon ( <img src="assets/settings-icon.svg" alt="Settings Icon" style="vertical-align: middle; width: 16px; height: 16px;"> ) next to the main button to access the settings menu, where you can:

- Choose between **ChatGPT**, **Gemini**, or **DeepSeek** for answering questions
- See the status of your AI assistant connections
- Check if your selected AI assistant is ready to use
- Configure humanlike answer pacing with **Answer Delay** controls
  (defaults: enabled, 12s average, +/-3s jitter)

The extension will automatically use your selected AI model for all future automation sessions.

## Disclaimer

This tool is for educational purposes only. Use it responsibly and be aware of your institution's academic integrity policies.

## Issues

Found a bug? [Create an issue](https://github.com/GooglyBlox/auto-mcgraw/issues).
