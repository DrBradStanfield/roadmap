import { describe, it, expect } from 'vitest';
import { isBotUA } from './bot-detect';

describe('isBotUA', () => {
  it('matches major search engine crawlers', () => {
    expect(isBotUA('Googlebot/2.1 (+http://www.google.com/bot.html)')).toBe(true);
    expect(isBotUA('Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)')).toBe(true);
    expect(isBotUA('DuckDuckBot/1.0; (+http://duckduckgo.com/duckduckbot.html)')).toBe(true);
  });

  it('matches social-preview crawlers', () => {
    expect(isBotUA('facebookexternalhit/1.1')).toBe(true);
    expect(isBotUA('Twitterbot/1.0')).toBe(true);
    expect(isBotUA('Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)')).toBe(true);
    expect(isBotUA('LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)')).toBe(true);
    expect(isBotUA('Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)')).toBe(true);
  });

  it('matches AI/LLM scrapers', () => {
    expect(isBotUA('Mozilla/5.0 (compatible; GPTBot/1.0; +https://openai.com/gptbot)')).toBe(true);
    expect(isBotUA('Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)')).toBe(true);
    expect(isBotUA('Mozilla/5.0 (compatible; PerplexityBot/1.0; +https://www.perplexity.ai/bot)')).toBe(true);
    expect(isBotUA('Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ChatGPT-User/1.0; +https://openai.com/bot)')).toBe(true);
  });

  it('matches headless browsers and automation frameworks', () => {
    expect(isBotUA('Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/121.0.0.0 Safari/537.36')).toBe(true);
    expect(isBotUA('Puppeteer/21.0.0')).toBe(true);
    expect(isBotUA('Playwright/1.40.0')).toBe(true);
  });

  it('matches HTTP clients commonly used by scrapers', () => {
    expect(isBotUA('curl/8.4.0')).toBe(true);
    expect(isBotUA('Wget/1.21.4')).toBe(true);
    expect(isBotUA('python-requests/2.31.0')).toBe(true);
    expect(isBotUA('axios/1.6.0')).toBe(true);
    expect(isBotUA('node-fetch/2.7.0')).toBe(true);
  });

  it('matches uptime/monitoring services', () => {
    expect(isBotUA('Pingdom.com_bot_version_1.4_(http://www.pingdom.com)')).toBe(true);
    expect(isBotUA('Mozilla/5.0+(compatible;+UptimeRobot/2.0;+http://www.uptimerobot.com/)')).toBe(true);
    expect(isBotUA('Mozilla/5.0 (X11; Linux x86_64) Chrome-Lighthouse')).toBe(true);
  });

  it('does NOT match real human browsers', () => {
    expect(isBotUA('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36')).toBe(false);
    expect(isBotUA('Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1')).toBe(false);
    expect(isBotUA('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Mobile Safari/537.36')).toBe(false);
    expect(isBotUA('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0')).toBe(false);
    expect(isBotUA('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36 Edg/121.0.0.0')).toBe(false);
    expect(isBotUA('Mozilla/5.0 (Linux; Android 13; SM-S918U) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36')).toBe(false);
  });

  it('handles missing/empty UA safely', () => {
    expect(isBotUA('')).toBe(false);
    expect(isBotUA(null)).toBe(false);
  });
});
