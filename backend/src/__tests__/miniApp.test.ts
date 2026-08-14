import { describe, it, expect } from 'vitest';
import { Api } from 'telegram';
import { webButtonOf, parseBotStartLink, withClientLaunchParams } from '../tg/miniApp';
import { solveArithmetic } from '../jobs/cloudflare';

describe('webButtonOf', () => {
  it('reads a plain URL button', () => {
    const btn = new Api.KeyboardButtonUrl({ text: '我不是机器人', url: 'https://example.com/v' });
    expect(webButtonOf(btn)).toEqual({ text: '我不是机器人', url: 'https://example.com/v', miniApp: false });
  });

  it('flags a Mini App (WebView) button', () => {
    const btn = new Api.KeyboardButtonWebView({ text: '📱 打开小程序签到', url: 'https://eoos.top/telegram-miniapp' });
    expect(webButtonOf(btn)).toEqual({
      text: '📱 打开小程序签到',
      url: 'https://eoos.top/telegram-miniapp',
      miniApp: true,
    });
  });

  it('flags a simple WebView button', () => {
    const btn = new Api.KeyboardButtonSimpleWebView({ text: 'Verify', url: 'https://example.com/app' });
    expect(webButtonOf(btn)?.miniApp).toBe(true);
  });

  it('ignores callback buttons', () => {
    const btn = new Api.KeyboardButtonCallback({ text: '签到', data: Buffer.from('x') });
    expect(webButtonOf(btn)).toBeUndefined();
  });

  it('treats a t.me named mini app link as a Mini App', () => {
    const btn = new Api.KeyboardButtonUrl({
      text: '在 App 中验证',
      url: 'https://telegram.me/verifybot/panel?startapp=L3dlYi12ZXJpZnkvLTEwMDEyMzQ1Njc4OTAvMTIzNDU2Nzg5MA%3D%3D',
    });
    const web = webButtonOf(btn);
    expect(web?.miniApp).toBe(true);
    expect(web?.miniAppLink).toEqual({
      botUsername: 'verifybot',
      appShortName: 'panel',
      // padding stripped: Telegram rejects '=' in start_param
      startParam: 'L3dlYi12ZXJpZnkvLTEwMDEyMzQ1Njc4OTAvMTIzNDU2Nzg5MA',
    });
  });

  it('marks a t.me ?start= link as a deep link, not a page to load', () => {
    const btn = new Api.KeyboardButtonUrl({
      text: '在私信中验证',
      url: 'https://telegram.me/verifybot?start=joinverify_-1001234567890',
    });
    const web = webButtonOf(btn);
    expect(web?.miniApp).toBe(false);
    expect(web?.startLink).toEqual({
      botUsername: 'verifybot',
      startParam: 'joinverify_-1001234567890',
    });
  });

  it('leaves an ordinary URL button alone', () => {
    const btn = new Api.KeyboardButtonUrl({ text: '打开浏览器验证', url: 'https://verify.example.com/#/web-verify/-100/1' });
    const web = webButtonOf(btn);
    expect(web?.miniApp).toBe(false);
    expect(web?.startLink).toBeUndefined();
    expect(web?.miniAppLink).toBeUndefined();
  });
});

describe('parseBotStartLink', () => {
  it('reads the payload a group bot hands to a private chat', () => {
    expect(parseBotStartLink('https://t.me/somebot?start=joinverify_-100123')).toEqual({
      botUsername: 'somebot',
      startParam: 'joinverify_-100123',
    });
  });

  it('ignores mini app links and non-Telegram URLs', () => {
    expect(parseBotStartLink('https://t.me/somebot/panel?startapp=abc')).toBeNull();
    expect(parseBotStartLink('https://example.com/?start=abc')).toBeNull();
  });
});

describe('solveArithmetic', () => {
  it('solves the captcha forms mini apps use', () => {
    expect(solveArithmetic('签到验证\n5 + 3 = ?')).toBe('8');
    expect(solveArithmetic('8 + 2 = ?')).toBe('10');
    expect(solveArithmetic('9 - 4 = ？')).toBe('5');
    expect(solveArithmetic('6 × 7 =?')).toBe('42');
  });

  it('ignores numbers that are not a posed question', () => {
    expect(solveArithmetic('2026/08/10 到期')).toBeUndefined();
    expect(solveArithmetic('当前积分 43')).toBeUndefined();
  });
});

describe('withClientLaunchParams', () => {
  const signed =
    'https://web.nebula-media.org/#tgWebAppData=query_id%3Dx%26hash%3Dab' +
    '&tgWebAppVersion=8.0&tgWebAppPlatform=web&tgWebAppBotInline=1';

  it('adds the theme Telegram leaves to the client', () => {
    const out = withClientLaunchParams(signed);
    expect(out.startsWith(signed)).toBe(true);
    const theme = new URLSearchParams(out.split('#')[1]).get('tgWebAppThemeParams');
    expect(JSON.parse(theme!)).toMatchObject({ bg_color: '#ffffff' });
  });

  it('fills in the version and platform a simple webview answers without', () => {
    const out = withClientLaunchParams('https://app.example.com/#tgWebAppData=query_id%3Dx');
    const params = new URLSearchParams(out.split('#')[1]);
    expect(params.get('tgWebAppVersion')).toBe('8.0');
    expect(params.get('tgWebAppPlatform')).toBe('web');
  });

  it('keeps what Telegram already sent', () => {
    const out = withClientLaunchParams(signed + '&tgWebAppThemeParams=%7B%7D');
    expect(out.match(/tgWebAppThemeParams=/g)).toHaveLength(1);
    expect(out).toContain('tgWebAppVersion=8.0');
    expect(out.match(/tgWebAppVersion=/g)).toHaveLength(1);
  });

  it('opens a fragment on an address that has none', () => {
    expect(withClientLaunchParams('https://app.example.com/?a=b')).toContain('/?a=b#tgWebAppVersion=8.0');
  });
});
