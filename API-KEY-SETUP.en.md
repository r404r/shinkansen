**English** | [繁體中文](API-KEY-SETUP.md)

# Shinkansen — Google Gemini API key setup guide

> This guide walks you through getting a Gemini API key for Shinkansen to use Google Gemini for web translation. Should take about 3 minutes.

### Step 1: Sign in to Google AI Studio

1. Open [Google AI Studio](https://aistudio.google.com/) and sign in with your Google account
2. On first sign-in, accept the terms of service and click "Continue"

### Step 2: Create an API key

Go to the [API keys page](https://aistudio.google.com/api-keys).

1. Click "**Create API key**" in the **top right** of the page
2. Name the key (e.g., `Shinkansen` — just for your own reference)
3. Under "Choose an imported project", select which Google Cloud project to associate with this key:
   - Use the default **General Gemini Apps**, or
   - Choose "**Create new project**" to create a dedicated project, e.g., `ShinkansenTranslation`
4. Click "**Create key**"

The API key appears immediately, in the form `AIzaSy...` (around 39 characters).

> **Tip**: you can always return to the API keys page later and click the key name to copy the full string — no need to worry if you miss it the first time. Still, copying it into a password manager or somewhere safe right away is recommended.

### Step 3: Configure the API key in Shinkansen

1. In Chrome, click the Shinkansen toolbar icon → Settings
2. Paste the key you just copied into the "**Gemini API Key**" field
3. Click "Save", then click "Test" to verify the key works
4. Open any English web page and press Option+S (Mac) or Alt+S (Windows) to test translation

### Step 4: Add a billing method

The free tier has **RPD** (requests per day), **RPM** (requests per minute), and **TPM** (tokens per minute) limits.

1. Open [Google AI Studio](https://aistudio.google.com/)
2. Click "**Billing**" in the left menu
3. Click "**Set up billing**"
4. Enter your payment info (name, address, credit card)
5. After submission, AI Studio automatically upgrades your project to Tier 1, raising RPD / RPM limits and unlocking advanced models like Pro

**Monthly spending cap**: Google enforces a $250 USD per-month cap on Tier 1 accounts. This is a safety mechanism to prevent unexpected runaway bills.

*Last updated: 2026-04-30*
