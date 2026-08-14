// Unit tests for tg/liveClient.ts
// Covers entity helpers, client lifecycle, message ops, contacts, search, and pub/sub.
// vi.hoisted ensures mock classes are available inside the vi.mock() factory.

const {
  MockUser, MockChat, MockChannel,
  MockPeerUser, MockPeerChannel, MockPeerChat,
  MockMessage, MockChatInvite, MockChatInviteAlready, MockChatInvitePeek,
  MockMessageMediaPhoto, MockMessageMediaDocument, MockMessageMediaContact,
  MockDocument, MockReplyInlineMarkup,
  MockDocAttrSticker, MockDocAttrAudio, MockDocAttrVideo, MockDocAttrFilename,
  MockMessageService, MockActionChatAddUser, MockActionChatJoinedByLink,
  MockActionChatJoinedByRequest, MockActionChatDeleteUser, MockActionPinMessage,
  MockActionChatEditTitle, MockActionChatEditPhoto, MockActionChatDeletePhoto,
  MockActionChatCreate, MockActionChannelCreate, MockActionUnsupported,
  MockChannelParticipantCreator, MockChannelParticipantAdmin,
  MockChatParticipantCreator, MockChatParticipantAdmin,
  MockTelegramClient, mockClientInstance,
  mockAddEventHandler, mockGetDialogs, mockGetMessages, mockSendMessage, mockInvoke,
  mockGetParticipants, mockGetEntity,
} = vi.hoisted(() => {
  class MockUser { constructor(d: Record<string, any>) { Object.assign(this, d); } }
  class MockChat { constructor(d: Record<string, any>) { Object.assign(this, d); } }
  class MockChannel { constructor(d: Record<string, any>) { Object.assign(this, d); } }
  class MockPeerUser { constructor(d: Record<string, any>) { Object.assign(this, d); } }
  class MockPeerChannel { constructor(d: Record<string, any>) { Object.assign(this, d); } }
  class MockPeerChat { constructor(d: Record<string, any>) { Object.assign(this, d); } }
  class MockMessage { constructor(d: Record<string, any>) { Object.assign(this, d); } }
  class MockChatInvite { constructor(d: Record<string, any>) { Object.assign(this, d); } }
  class MockChatInviteAlready { constructor(d: Record<string, any>) { Object.assign(this, d); } }
  class MockChatInvitePeek { constructor(d: Record<string, any>) { Object.assign(this, d); } }
  class MockMessageMediaPhoto {}
  class MockMessageMediaDocument { constructor(d: Record<string, any> = {}) { Object.assign(this, d); } }
  class MockMessageMediaContact { constructor(d: Record<string, any> = {}) { Object.assign(this, d); } }
  class MockDocument { constructor(d: Record<string, any> = {}) { Object.assign(this, d); } }
  class MockReplyInlineMarkup {
    rows: Array<{ buttons: Array<{ text: string }> }>;
    constructor(d: any) { this.rows = d.rows; }
  }

  class MockDocAttrSticker {}
  class MockDocAttrAudio { constructor(d: Record<string, any> = {}) { Object.assign(this, d); } }
  class MockDocAttrVideo {}
  class MockDocAttrFilename { constructor(d: Record<string, any>) { Object.assign(this, d); } }

  class MockMessageService { constructor(d: Record<string, any>) { Object.assign(this, d); } }
  class MockActionChatAddUser { constructor(d: Record<string, any>) { Object.assign(this, d); } }
  class MockActionChatJoinedByLink { constructor(d: Record<string, any> = {}) { Object.assign(this, d); } }
  class MockActionChatJoinedByRequest {}
  class MockActionChatDeleteUser { constructor(d: Record<string, any>) { Object.assign(this, d); } }
  class MockActionPinMessage {}
  class MockActionChatEditTitle { constructor(d: Record<string, any>) { Object.assign(this, d); } }
  class MockActionChatEditPhoto {}
  class MockActionChatDeletePhoto {}
  class MockActionChatCreate { constructor(d: Record<string, any> = {}) { Object.assign(this, d); } }
  class MockActionChannelCreate { constructor(d: Record<string, any> = {}) { Object.assign(this, d); } }
  class MockActionUnsupported {}

  class MockChannelParticipantCreator { constructor(d: Record<string, any> = {}) { Object.assign(this, d); } }
  class MockChannelParticipantAdmin { constructor(d: Record<string, any> = {}) { Object.assign(this, d); } }
  class MockChatParticipantCreator { constructor(d: Record<string, any> = {}) { Object.assign(this, d); } }
  class MockChatParticipantAdmin { constructor(d: Record<string, any> = {}) { Object.assign(this, d); } }

  const mockAddEventHandler = vi.fn();
  const mockGetDialogs      = vi.fn().mockResolvedValue([]);
  const mockGetMessages     = vi.fn().mockResolvedValue([]);
  const mockSendMessage     = vi.fn().mockResolvedValue({ id: 1, date: 1700000000 });
  const mockInvoke          = vi.fn().mockResolvedValue({ users: [], chats: [] });
  const mockGetParticipants = vi.fn().mockResolvedValue([]);
  // Unresolvable by default: name lookups fall back the same way they do without a cache hit
  const mockGetEntity       = vi.fn().mockRejectedValue(new Error('not found'));

  const mockClientInstance = {
    connect:         vi.fn().mockResolvedValue(undefined),
    destroy:         vi.fn().mockResolvedValue(undefined),
    connected:       true,
    addEventHandler: mockAddEventHandler,
    getDialogs:      mockGetDialogs,
    getMessages:     mockGetMessages,
    sendMessage:     mockSendMessage,
    invoke:          mockInvoke,
    getParticipants: mockGetParticipants,
    downloadMedia:   vi.fn(),
    getInputEntity:  vi.fn().mockResolvedValue({}),
    getEntity:       mockGetEntity,
  };

  const MockTelegramClient = vi.fn().mockReturnValue(mockClientInstance);

  return {
    MockUser, MockChat, MockChannel,
    MockPeerUser, MockPeerChannel, MockPeerChat,
    MockMessage, MockChatInvite, MockChatInviteAlready, MockChatInvitePeek,
    MockMessageMediaPhoto, MockMessageMediaDocument, MockMessageMediaContact,
    MockDocument, MockReplyInlineMarkup,
    MockDocAttrSticker, MockDocAttrAudio, MockDocAttrVideo, MockDocAttrFilename,
    MockMessageService, MockActionChatAddUser, MockActionChatJoinedByLink,
    MockActionChatJoinedByRequest, MockActionChatDeleteUser, MockActionPinMessage,
    MockActionChatEditTitle, MockActionChatEditPhoto, MockActionChatDeletePhoto,
    MockActionChatCreate, MockActionChannelCreate, MockActionUnsupported,
    MockChannelParticipantCreator, MockChannelParticipantAdmin,
    MockChatParticipantCreator, MockChatParticipantAdmin,
    MockTelegramClient, mockClientInstance,
    mockAddEventHandler, mockGetDialogs, mockGetMessages, mockSendMessage, mockInvoke,
    mockGetParticipants, mockGetEntity,
  };
});

vi.mock('telegram', () => ({
  TelegramClient: MockTelegramClient,
  Api: {
    User:                MockUser,
    Chat:                MockChat,
    Channel:             MockChannel,
    PeerUser:            MockPeerUser,
    PeerChannel:         MockPeerChannel,
    PeerChat:            MockPeerChat,
    Message:             MockMessage,
    MessageService:      MockMessageService,
    MessageActionChatAddUser:         MockActionChatAddUser,
    MessageActionChatJoinedByLink:    MockActionChatJoinedByLink,
    MessageActionChatJoinedByRequest: MockActionChatJoinedByRequest,
    MessageActionChatDeleteUser:      MockActionChatDeleteUser,
    MessageActionPinMessage:          MockActionPinMessage,
    MessageActionChatEditTitle:       MockActionChatEditTitle,
    MessageActionChatEditPhoto:       MockActionChatEditPhoto,
    MessageActionChatDeletePhoto:     MockActionChatDeletePhoto,
    MessageActionChatCreate:          MockActionChatCreate,
    MessageActionChannelCreate:       MockActionChannelCreate,
    MessageMediaPhoto:   MockMessageMediaPhoto,
    MessageMediaDocument: MockMessageMediaDocument,
    MessageMediaContact: MockMessageMediaContact,
    Document:            MockDocument,
    DocumentAttributeSticker:  MockDocAttrSticker,
    DocumentAttributeAudio:    MockDocAttrAudio,
    DocumentAttributeVideo:    MockDocAttrVideo,
    DocumentAttributeFilename: MockDocAttrFilename,
    ReplyInlineMarkup:   MockReplyInlineMarkup,
    contacts: {
      GetContacts:    vi.fn().mockImplementation((d: any) => d),
      ImportContacts: vi.fn().mockImplementation((d: any) => d),
      Search:         vi.fn().mockImplementation((d: any) => d),
    },
    messages: {
      SearchGlobal:     vi.fn().mockImplementation((d: any) => d),
      // Tagged so mockInvoke routing can tell the two hash requests apart
      CheckChatInvite:  vi.fn().mockImplementation((d: any) => ({ checkHash: d.hash })),
      ImportChatInvite: vi.fn().mockImplementation((d: any) => ({ importHash: d.hash })),
    },
    channels: {
      JoinChannel: vi.fn().mockImplementation((d: any) => ({ joinChannel: d.channel })),
    },
    ChannelParticipantCreator: MockChannelParticipantCreator,
    ChannelParticipantAdmin:   MockChannelParticipantAdmin,
    ChatParticipantCreator:    MockChatParticipantCreator,
    ChatParticipantAdmin:      MockChatParticipantAdmin,
    ChatInvite:        MockChatInvite,
    ChatInviteAlready: MockChatInviteAlready,
    ChatInvitePeek:    MockChatInvitePeek,
    InputChannelFromMessage: vi.fn().mockImplementation((d: any) => ({ fromMessage: true, ...d })),
    InputMessagesFilterEmpty: vi.fn().mockImplementation(() => ({})),
    InputPeerEmpty:           vi.fn().mockImplementation(() => ({})),
    InputPhoneContact: vi.fn().mockImplementation((d: any) => d),
    updates: {
      GetState: vi.fn().mockImplementation((d: any) => d),
    },
  },
  Logger: vi.fn().mockReturnValue({}),
}));

vi.mock('telegram/extensions/Logger', () => ({
  LogLevel: { NONE: 0 },
}));

vi.mock('telegram/sessions', () => ({
  StringSession: vi.fn().mockReturnValue({}),
}));

vi.mock('telegram/events', () => ({
  NewMessage: vi.fn().mockReturnValue({}),
  Raw:        vi.fn().mockReturnValue({}),
}));

vi.mock('../db/database', () => ({
  db: {
    prepare:     vi.fn(),
    transaction: vi.fn().mockImplementation((fn: () => void) => fn),
  },
}));

vi.mock('../jobs/runner', () => ({
  parseTgProxy: vi.fn().mockReturnValue(undefined),
}));

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TelegramClient } from 'telegram';
import {
  entityToChatId,
  peerToChatId,
  getLiveClient,
  loadDialogs,
  getMessages,
  sendMessage,
  getContacts,
  addContact,
  searchPeers,
  joinChannel,
  subscribeToMessages,
  sweepLiveClients,
  parseMiniAppLink,
  fetchPhoto,
  normalisePhoneNumber,
  getChatMembers,
} from '../tg/liveClient';
import { db } from '../db/database';

const DEFAULT_ACCOUNT = {
  api_id: 12345,
  api_hash: 'abc123',
  session_string: 'test-session',
  proxy_id: null,
  app_client_id: null,
};

function setupDb(row: Record<string, any> | null = DEFAULT_ACCOUNT) {
  vi.mocked(db.prepare).mockImplementation((sql: string) => ({
    get: vi.fn().mockReturnValue(sql.includes('tg_accounts') ? row : null),
    run: vi.fn().mockReturnValue(undefined),
    all: vi.fn().mockReturnValue([]),
  } as any));
}

// Helper to build a LiveEntry without going through getLiveClient
function makeEntry(cacheEntries: [string, any][] = []) {
  return {
    client:            mockClientInstance as any,
    entityCache:       new Map<string, any>(cacheEntries),
    subscribers:       new Set<any>(),
    dialogSubscribers: new Set<any>(),
    avatarCache:       new Map<string, any>(),
    readOutboxCache:   new Map<string, number>(),
    readSubscribers:   new Set<any>(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  setupDb();
});

// ---- entityToChatId --------------------------------------------------------

describe('entityToChatId', () => {
  it('returns u-prefixed id for User', () => {
    expect(entityToChatId(new MockUser({ id: 42n }) as any)).toBe('u42');
  });

  it('returns c-prefixed id for Channel', () => {
    expect(entityToChatId(new MockChannel({ id: 99n }) as any)).toBe('c99');
  });

  it('returns g-prefixed id for Chat (group)', () => {
    expect(entityToChatId(new MockChat({ id: 7n }) as any)).toBe('g7');
  });
});

// ---- peerToChatId ----------------------------------------------------------

describe('peerToChatId', () => {
  it('returns u-prefixed id for PeerUser', () => {
    expect(peerToChatId(new MockPeerUser({ userId: 10n }) as any)).toBe('u10');
  });

  it('returns c-prefixed id for PeerChannel', () => {
    expect(peerToChatId(new MockPeerChannel({ channelId: 20n }) as any)).toBe('c20');
  });

  it('returns g-prefixed id for PeerChat', () => {
    expect(peerToChatId(new MockPeerChat({ chatId: 30n }) as any)).toBe('g30');
  });

  it('returns empty string for an unknown peer type', () => {
    expect(peerToChatId({} as any)).toBe('');
  });
});

// ---- getLiveClient ---------------------------------------------------------

// Each test uses a unique account ID (3xx range) to avoid hitting the
// module-level liveClients cache from a prior test.

describe('getLiveClient', () => {
  it('creates and connects a TelegramClient with DB credentials', async () => {
    await getLiveClient(300);

    expect(MockTelegramClient).toHaveBeenCalledTimes(1);
    expect(mockClientInstance.connect).toHaveBeenCalledTimes(1);
    const args = vi.mocked(TelegramClient).mock.calls[0];
    expect(args[1]).toBe(12345);
    expect(args[2]).toBe('abc123');
  });

  it('returns the cached entry on a second call without creating a new client', async () => {
    const first  = await getLiveClient(301);
    const second = await getLiveClient(301);

    expect(first).toBe(second);
    expect(MockTelegramClient).toHaveBeenCalledTimes(1);
  });

  it('throws when the account row is not found in the DB', async () => {
    setupDb(null);
    await expect(getLiveClient(302)).rejects.toThrow('Account not found or not authenticated');
  });

  it('throws when session_string is null', async () => {
    setupDb({ ...DEFAULT_ACCOUNT, session_string: null });
    await expect(getLiveClient(303)).rejects.toThrow('Account not found or not authenticated');
  });

  it('builds one client when two callers ask for the same idle account at once', async () => {
    // Both callers see no cached entry. Without an in-flight guard each builds and connects
    // its own client and the second overwrites the first, leaving a live, connected session
    // that nothing can reach and that keeps running until the process restarts.
    const [first, second] = await Promise.all([getLiveClient(304), getLiveClient(304)]);

    expect(first).toBe(second);
    expect(MockTelegramClient).toHaveBeenCalledTimes(1);
    expect(mockClientInstance.connect).toHaveBeenCalledTimes(1);
  });

  it('does not wedge the account when a connect fails', async () => {
    setupDb(null);
    await expect(getLiveClient(305)).rejects.toThrow();
    // The failed attempt must not be cached, or the account could never connect again
    setupDb(DEFAULT_ACCOUNT);
    await expect(getLiveClient(305)).resolves.toBeDefined();
  });
});

// ---- loadDialogs -----------------------------------------------------------

describe('loadDialogs', () => {
  it('populates the entity cache for each dialog entity', async () => {
    const user = new MockUser({ id: 1n, firstName: 'Alice' });
    mockGetDialogs.mockResolvedValueOnce([
      { entity: user, name: 'Alice', dialog: { unreadCount: 0 }, message: undefined },
    ]);

    const entry = makeEntry();
    await loadDialogs(entry as any);

    expect(entry.entityCache.has('u1')).toBe(true);
  });

  it('returns type=user for a regular (non-bot) User', async () => {
    const user = new MockUser({ id: 2n, firstName: 'Bob', bot: false });
    mockGetDialogs.mockResolvedValueOnce([
      { entity: user, name: 'Bob', dialog: { unreadCount: 1 }, message: undefined },
    ]);

    const result = await loadDialogs(makeEntry() as any);

    expect(result[0]).toMatchObject({ chatId: 'u2', type: 'user' });
  });

  it('returns type=bot for a bot User', async () => {
    const bot = new MockUser({ id: 3n, username: 'mybot', bot: true });
    mockGetDialogs.mockResolvedValueOnce([
      { entity: bot, name: 'My Bot', dialog: { unreadCount: 0 }, message: undefined },
    ]);

    const result = await loadDialogs(makeEntry() as any);

    expect(result[0].type).toBe('bot');
  });

  it('returns type=channel for a non-megagroup Channel', async () => {
    const ch = new MockChannel({ id: 4n, title: 'News', megagroup: false });
    mockGetDialogs.mockResolvedValueOnce([
      { entity: ch, name: 'News', dialog: { unreadCount: 0 }, message: undefined },
    ]);

    const result = await loadDialogs(makeEntry() as any);

    expect(result[0]).toMatchObject({ chatId: 'c4', type: 'channel' });
  });

  it('includes lastMessage and unreadCount when present on the dialog', async () => {
    const user = new MockUser({ id: 5n, firstName: 'Eve' });
    mockGetDialogs.mockResolvedValueOnce([
      {
        entity:  user,
        name:    'Eve',
        dialog:  { unreadCount: 3 },
        message: { message: 'Hi!', date: 1700000000, out: false },
      },
    ]);

    const result = await loadDialogs(makeEntry() as any);

    expect(result[0].unreadCount).toBe(3);
    expect(result[0].lastMessage).toEqual({ text: 'Hi!', date: 1700000000, fromMe: false });
  });
});

// ---- getMessages -----------------------------------------------------------

describe('getMessages', () => {
  it('returns formatted message payloads from the entity in cache', async () => {
    const user  = new MockUser({ id: 10n });
    const entry = makeEntry([['u10', user]]);

    mockGetMessages.mockResolvedValueOnce([
      new MockMessage({ id: 1, message: 'Hello', date: 1700000000, out: false, fromId: null, media: null, replyMarkup: null }),
    ]);

    const result = await getMessages(entry as any, 'u10', 20, 0);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: 1, text: 'Hello', date: 1700000000, fromMe: false });
  });

  it('sets fromMe=true when msg.out is truthy', async () => {
    const user  = new MockUser({ id: 11n });
    const entry = makeEntry([['u11', user]]);

    mockGetMessages.mockResolvedValueOnce([
      new MockMessage({ id: 2, message: 'Sent', date: 1700000001, out: true, fromId: null, media: null, replyMarkup: null }),
    ]);

    const [msg] = await getMessages(entry as any, 'u11', 20, 0);
    expect(msg.fromMe).toBe(true);
  });

  it('sets hasPhoto=true when media is MessageMediaPhoto', async () => {
    const user  = new MockUser({ id: 12n });
    const entry = makeEntry([['u12', user]]);

    mockGetMessages.mockResolvedValueOnce([
      new MockMessage({ id: 3, message: '', date: 1700000002, out: false, fromId: null, media: new MockMessageMediaPhoto(), replyMarkup: null }),
    ]);

    const [msg] = await getMessages(entry as any, 'u12', 20, 0);
    expect(msg.hasPhoto).toBe(true);
    expect(msg.hasDocument).toBe(false);
  });

  it('describes a contact card, which carries no message text of its own', async () => {
    const user  = new MockUser({ id: 22n });
    const entry = makeEntry([['u22', user]]);

    mockGetMessages.mockResolvedValueOnce([
      new MockMessage({
        id: 4, message: '', date: 1700000003, out: true, fromId: null, replyMarkup: null,
        media: new MockMessageMediaContact({ phoneNumber: '10000000000', firstName: 'Ada', lastName: '' }),
      }),
    ]);

    const [msg] = await getMessages(entry as any, 'u22', 20, 0);
    expect(msg.text).toBe('Ada +10000000000');
  });

  it('calls loadDialogs via ensureEntityCached when entity is not in cache', async () => {
    const user  = new MockUser({ id: 13n });
    const entry = makeEntry(); // empty cache

    mockGetDialogs.mockResolvedValueOnce([
      { entity: user, name: 'Test', dialog: { unreadCount: 0 }, message: undefined },
    ]);
    mockGetMessages.mockResolvedValueOnce([
      new MockMessage({ id: 4, message: 'Hi', date: 1700000003, out: false, fromId: null, media: null, replyMarkup: null }),
    ]);

    await getMessages(entry as any, 'u13', 20, 0);

    expect(mockGetDialogs).toHaveBeenCalledTimes(1);
  });
});

// ---- getMessages: reply quotes ---------------------------------------------

describe('getMessages reply quotes', () => {
  const group = () => new MockChannel({ id: 700n, megagroup: true, title: 'The Group' });

  function reply(id: number, replyToMsgId: number) {
    return new MockMessage({
      id, message: 'sure', date: 1700000100, out: false, fromId: null,
      media: null, replyMarkup: null,
      replyTo: { className: 'MessageReplyHeader', replyToMsgId },
    });
  }

  function quoted(id: number, over: Record<string, any>) {
    return new MockMessage({
      id, message: '', date: 1700000000, out: false, media: null, replyMarkup: null,
      fromId: new MockPeerUser({ userId: 42n }), ...over,
    });
  }

  it('names the quoted sender even when they are not in the entity cache', async () => {
    const entry = makeEntry([['c700', group()]]);
    mockGetEntity.mockResolvedValueOnce(new MockUser({ id: 42n, firstName: 'Ada' }));
    mockGetMessages
      .mockResolvedValueOnce([reply(2, 1)])
      .mockResolvedValueOnce([quoted(1, { message: 'the original' })]);

    const [msg] = await getMessages(entry as any, 'c700', 20, 0);

    expect(msg.replyToName).toBe('Ada');
    expect(msg.replyToText).toBe('the original');
    expect(entry.entityCache.get('u42')).toMatchObject({ firstName: 'Ada' });
  });

  it('describes a quoted photo, which has no text to show', async () => {
    const entry = makeEntry([['c700', group()], ['u42', new MockUser({ id: 42n, firstName: 'Ada' })]]);
    mockGetMessages
      .mockResolvedValueOnce([reply(4, 3)])
      .mockResolvedValueOnce([quoted(3, { media: new MockMessageMediaPhoto() })]);

    const [msg] = await getMessages(entry as any, 'c700', 20, 0);

    expect(msg.replyToText).toBe('');
    expect(msg.replyToMedia).toBe('photo');
  });

  it('reports a quoted file with its name, so the quote says which file', async () => {
    const entry = makeEntry([['c700', group()], ['u42', new MockUser({ id: 42n, firstName: 'Ada' })]]);
    const doc = new MockDocument({ attributes: [new MockDocAttrFilename({ fileName: 'report.pdf' })] });
    mockGetMessages
      .mockResolvedValueOnce([reply(6, 5)])
      .mockResolvedValueOnce([quoted(5, { media: new MockMessageMediaDocument({ document: doc }) })]);

    const [msg] = await getMessages(entry as any, 'c700', 20, 0);

    expect(msg.replyToMedia).toBe('document');
    expect(msg.replyToFileName).toBe('report.pdf');
  });

  it('tells a voice message apart from other audio', async () => {
    const entry = makeEntry([['c700', group()]]);
    const doc = new MockDocument({ attributes: [new MockDocAttrAudio({ voice: true })] });
    mockGetMessages
      .mockResolvedValueOnce([reply(8, 7)])
      .mockResolvedValueOnce([quoted(7, { media: new MockMessageMediaDocument({ document: doc }) })]);

    const [msg] = await getMessages(entry as any, 'c700', 20, 0);
    expect(msg.replyToMedia).toBe('voice');
  });

  it('credits the group itself when the quoted message has no sender', async () => {
    const entry = makeEntry([['c700', group()]]);
    mockGetMessages
      .mockResolvedValueOnce([reply(10, 9)])
      .mockResolvedValueOnce([quoted(9, { fromId: null, message: 'notice' })]);

    const [msg] = await getMessages(entry as any, 'c700', 20, 0);
    expect(msg.replyToName).toBe('The Group');
  });
});

// ---- getMessages: service notices ------------------------------------------

describe('getMessages service notices', () => {
  const group = () => new MockChannel({ id: 800n, megagroup: true, title: 'Group' });

  function serviceMsg(id: number, action: any, fromUserId: bigint | null = 55n) {
    return new MockMessageService({
      id, date: 1700000000, out: false, action,
      peerId: new MockPeerChannel({ channelId: 800n }),
      fromId: fromUserId === null ? null : new MockPeerUser({ userId: fromUserId }),
    });
  }

  it('reports a self-join with the actor resolved from the entity cache', async () => {
    const entry = makeEntry([
      ['c800', group()],
      ['u55', new MockUser({ id: 55n, firstName: 'Ada', lastName: 'Lovelace' })],
    ]);

    mockGetMessages.mockResolvedValueOnce([
      serviceMsg(9, new MockActionChatAddUser({ users: [55n] })),
    ]);

    const [msg] = await getMessages(entry as any, 'c800', 20, 0);

    expect(msg.text).toBe('');
    expect(msg.service).toEqual({
      kind: 'join',
      actorId: 'u55',
      actorName: 'Ada Lovelace',
      targets: [],
      title: null,
    });
  });

  it('separates someone adding others from joining themselves', async () => {
    const entry = makeEntry([
      ['c800', group()],
      ['u55', new MockUser({ id: 55n, firstName: 'Ada' })],
      ['u66', new MockUser({ id: 66n, firstName: 'Bob' })],
    ]);

    mockGetMessages.mockResolvedValueOnce([
      serviceMsg(10, new MockActionChatAddUser({ users: [66n] })),
    ]);

    const [msg] = await getMessages(entry as any, 'c800', 20, 0);

    expect(msg.service).toMatchObject({
      kind: 'added',
      actorName: 'Ada',
      targets: [{ chatId: 'u66', name: 'Bob' }],
    });
  });

  it('treats a join by invite link as a join', async () => {
    const entry = makeEntry([['c800', group()], ['u55', new MockUser({ id: 55n, firstName: 'Ada' })]]);
    mockGetMessages.mockResolvedValueOnce([
      serviceMsg(11, new MockActionChatJoinedByLink({ inviterId: 1n })),
    ]);

    const [msg] = await getMessages(entry as any, 'c800', 20, 0);
    expect(msg.service?.kind).toBe('join');
  });

  it('tells leaving apart from being removed by someone else', async () => {
    const entry = makeEntry([
      ['c800', group()],
      ['u55', new MockUser({ id: 55n, firstName: 'Ada' })],
      ['u66', new MockUser({ id: 66n, firstName: 'Bob' })],
    ]);

    mockGetMessages.mockResolvedValueOnce([
      serviceMsg(12, new MockActionChatDeleteUser({ userId: 55n })),
      serviceMsg(13, new MockActionChatDeleteUser({ userId: 66n })),
    ]);

    const [left, removed] = await getMessages(entry as any, 'c800', 20, 0);
    expect(left.service?.kind).toBe('left');
    expect(removed.service).toMatchObject({
      kind: 'removed',
      targets: [{ chatId: 'u66', name: 'Bob' }],
    });
  });

  it('carries the new title on a rename', async () => {
    const entry = makeEntry([['c800', group()], ['u55', new MockUser({ id: 55n, firstName: 'Ada' })]]);
    mockGetMessages.mockResolvedValueOnce([
      serviceMsg(14, new MockActionChatEditTitle({ title: 'New Name' })),
    ]);

    const [msg] = await getMessages(entry as any, 'c800', 20, 0);
    expect(msg.service).toMatchObject({ kind: 'titleChanged', title: 'New Name' });
  });

  it('drops actions it has no wording for, rather than rendering a blank line', async () => {
    const entry = makeEntry([['c800', group()]]);
    mockGetMessages.mockResolvedValueOnce([
      serviceMsg(15, new MockActionUnsupported()),
      new MockMessage({ id: 16, message: 'Real', date: 1700000001, out: false, fromId: null, media: null, replyMarkup: null }),
    ]);

    const result = await getMessages(entry as any, 'c800', 20, 0);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: 16, text: 'Real' });
  });

  it('leaves service null on ordinary messages', async () => {
    const entry = makeEntry([['c800', group()]]);
    mockGetMessages.mockResolvedValueOnce([
      new MockMessage({ id: 17, message: 'Hi', date: 1700000002, out: false, fromId: null, media: null, replyMarkup: null }),
    ]);

    const [msg] = await getMessages(entry as any, 'c800', 20, 0);
    expect(msg.service).toBeNull();
  });
});

// ---- getChatMembers --------------------------------------------------------

describe('getChatMembers', () => {
  function participants(users: any[], total: number) {
    const list: any = [...users];
    list.total = total;
    return list;
  }

  it('maps participants, flags creator and admin, and reports the total', async () => {
    const group = new MockChannel({ id: 900n, megagroup: true, title: 'Group' });
    const entry = makeEntry([['c900', group]]);

    mockGetParticipants.mockResolvedValueOnce(participants([
      new MockUser({ id: 1n, firstName: 'Ada', lastName: 'Lovelace', username: 'ada', participant: new MockChannelParticipantCreator() }),
      new MockUser({ id: 2n, firstName: 'Bob', username: null, participant: new MockChannelParticipantAdmin() }),
      new MockUser({ id: 3n, firstName: 'Cid', username: 'cid', bot: true, participant: {} }),
    ], 42));

    const { members, total } = await getChatMembers(entry as any, 'c900', 200, 0);

    expect(total).toBe(42);
    expect(members).toEqual([
      { chatId: 'u1', peerId: '1', name: 'Ada Lovelace', username: 'ada', isBot: false, status: 'creator' },
      { chatId: 'u2', peerId: '2', name: 'Bob', username: null, isBot: false, status: 'admin' },
      { chatId: 'u3', peerId: '3', name: 'Cid', username: 'cid', isBot: true, status: 'member' },
    ]);
  });

  it('caches members as entities so their avatars and sender names resolve', async () => {
    const group = new MockChannel({ id: 901n, megagroup: true, title: 'Group' });
    const entry = makeEntry([['c901', group]]);

    mockGetParticipants.mockResolvedValueOnce(participants([
      new MockUser({ id: 7n, firstName: 'Eve', username: null, participant: {} }),
    ], 1));

    await getChatMembers(entry as any, 'c901', 200, 0);

    expect(entry.entityCache.get('u7')).toMatchObject({ firstName: 'Eve' });
  });

  it('passes limit, offset, and search through to Telegram', async () => {
    const group = new MockChannel({ id: 902n, megagroup: true, title: 'Group' });
    const entry = makeEntry([['c902', group]]);

    mockGetParticipants.mockResolvedValueOnce(participants([], 0));
    await getChatMembers(entry as any, 'c902', 50, 100, 'ada');

    expect(mockGetParticipants).toHaveBeenCalledWith(group, { limit: 50, offset: 100, search: 'ada' });
  });

  it('rejects a one-to-one chat, which has no participants to list', async () => {
    const entry = makeEntry([['u5', new MockUser({ id: 5n, firstName: 'Solo' })]]);
    await expect(getChatMembers(entry as any, 'u5', 200, 0)).rejects.toThrow(/members/i);
  });
});

// ---- sendMessage -----------------------------------------------------------

describe('sendMessage', () => {
  it('calls client.sendMessage with the cached entity and returns id + date', async () => {
    const user  = new MockUser({ id: 20n });
    const entry = makeEntry([['u20', user]]);

    mockSendMessage.mockResolvedValueOnce({ id: 99, date: 1700000010 });

    const result = await sendMessage(entry as any, 'u20', 'Hey there');

    expect(mockSendMessage).toHaveBeenCalledWith(user, { message: 'Hey there', parseMode: false });
    expect(result).toEqual({ id: 99, date: 1700000010 });
  });

  it('throws when entity is not found even after a cache reload', async () => {
    const entry = makeEntry(); // empty cache
    mockGetDialogs.mockResolvedValueOnce([]); // dialogs return nothing

    await expect(sendMessage(entry as any, 'u999', 'Fail')).rejects.toThrow('Chat not found');
  });
});

// ---- getContacts -----------------------------------------------------------

describe('getContacts', () => {
  it('returns a formatted contact list', async () => {
    const user = new MockUser({ id: 50n, firstName: 'Sam', lastName: 'Smith', username: 'samsmith', phone: '+61400000001' });
    mockInvoke.mockResolvedValueOnce({ users: [user] });

    const result = await getContacts(makeEntry() as any);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      chatId:    'u50',
      firstName: 'Sam',
      lastName:  'Smith',
      username:  'samsmith',
      phone:     '+61400000001',
    });
  });

  it('filters out deleted users', async () => {
    const deleted = new MockUser({ id: 51n, deleted: true });
    const active  = new MockUser({ id: 52n, firstName: 'Active' });
    mockInvoke.mockResolvedValueOnce({ users: [deleted, active] });

    const result = await getContacts(makeEntry() as any);

    expect(result).toHaveLength(1);
    expect(result[0].chatId).toBe('u52');
  });

  it('caches each contact entity', async () => {
    const user = new MockUser({ id: 53n, firstName: 'Cached' });
    mockInvoke.mockResolvedValueOnce({ users: [user] });

    const entry = makeEntry();
    await getContacts(entry as any);

    expect(entry.entityCache.has('u53')).toBe(true);
  });
});

// ---- addContact ------------------------------------------------------------

describe('addContact', () => {
  it('returns null when ImportContacts returns no users', async () => {
    mockInvoke.mockResolvedValueOnce({ users: [] });

    const result = await addContact(makeEntry() as any, '+61400000001', 'New');
    expect(result).toBeNull();
  });

  it('returns a formatted contact and caches the entity when user is found', async () => {
    const user = new MockUser({ id: 60n, firstName: 'New', lastName: 'Contact', username: null, phone: '+61400000001' });
    mockInvoke.mockResolvedValueOnce({ users: [user] });

    const entry  = makeEntry();
    const result = await addContact(entry as any, '+61400000001', 'New', 'Contact');

    expect(result).toMatchObject({ chatId: 'u60', firstName: 'New', lastName: 'Contact' });
    expect(entry.entityCache.has('u60')).toBe(true);
  });
});

// ---- searchPeers -----------------------------------------------------------

describe('searchPeers', () => {
  const emptyGlobal = { messages: [], chats: [], users: [] };
  const emptyFound = { users: [], chats: [] };

  // SearchGlobal requests carry offsetRate; contacts.Search requests don't
  function routeInvoke(handlers: {
    searchGlobal?: (req: any) => any;
    contactsSearch?: (req: any) => any;
  } = {}) {
    mockInvoke.mockImplementation(async (req: any) => {
      if ('offsetRate' in req) return handlers.searchGlobal?.(req) ?? emptyGlobal;
      return handlers.contactsSearch?.(req) ?? emptyFound;
    });
  }

  function contactsSearchCalls() {
    return mockInvoke.mock.calls.filter((c: any[]) => !('offsetRate' in c[0]));
  }

  it('returns formatted results for matching users', async () => {
    const user = new MockUser({ id: 70n, firstName: 'Found', username: 'found', bot: false });
    routeInvoke({ contactsSearch: () => ({ users: [user], chats: [] }) });

    const result = await searchPeers(makeEntry() as any, 'found');

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ chatId: 'u70', type: 'user' });
  });

  it('returns formatted results for matching channels', async () => {
    const channel = new MockChannel({ id: 71n, title: 'Tech News', megagroup: false });
    routeInvoke({ contactsSearch: () => ({ users: [], chats: [channel] }) });

    const result = await searchPeers(makeEntry() as any, 'tech');

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ chatId: 'c71', type: 'channel' });
  });

  it('finds own dialogs by title when the server searches return nothing', async () => {
    const group = new MockChannel({ id: 80n, title: 'Aurora 影音交流群', megagroup: true });
    mockGetDialogs.mockResolvedValueOnce([
      { entity: group, name: 'Aurora 影音交流群', dialog: { unreadCount: 0 }, message: undefined },
    ]);
    routeInvoke();

    const result = await searchPeers(makeEntry() as any, '影音交流');

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ chatId: 'c80', type: 'group' });
  });

  it('surfaces a left group returned only as a title-matched entity by searchGlobal', async () => {
    mockGetDialogs.mockResolvedValueOnce([]);
    const group = new MockChannel({
      id: 90n, title: 'Aurora 影音交流群', megagroup: true, left: true,
    });
    routeInvoke({ searchGlobal: () => ({ messages: [], chats: [group], users: [] }) });

    const result = await searchPeers(makeEntry() as any, 'Aurora 影音交流群');

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ chatId: 'c90', type: 'group', left: true });
  });

  it('ranks chats that merely mention the query in a message after other matches', async () => {
    mockGetDialogs.mockResolvedValueOnce([]);
    const mentionChat = new MockChannel({ id: 91n, title: 'Some Chatter', megagroup: true });
    const msg = new MockMessage({
      peerId: new MockPeerChannel({ channelId: 91n }),
      message: 'how do I join found group?',
      date: 1700000000,
      out: false,
    });
    const user = new MockUser({ id: 92n, firstName: 'Found', username: 'found', bot: false });
    routeInvoke({
      searchGlobal: () => ({ messages: [msg], chats: [mentionChat], users: [] }),
      contactsSearch: () => ({ users: [user], chats: [] }),
    });

    const result = await searchPeers(makeEntry() as any, 'found');

    expect(result.map((r) => r.chatId)).toEqual(['u92', 'c91']);
    expect(result[1].lastMessage?.text).toBe('how do I join found group?');
  });

  it('retries the server searches with trailing words dropped when the full query matches nothing', async () => {
    mockGetDialogs.mockResolvedValueOnce([]);
    const channel = new MockChannel({ id: 81n, title: 'Aurora Media Hub', megagroup: false });
    routeInvoke({
      contactsSearch: (req) =>
        req.q === 'Aurora Media Hub' ? { users: [], chats: [channel] } : emptyFound,
    });

    const result = await searchPeers(makeEntry() as any, 'Aurora Media Hub v9');

    expect(contactsSearchCalls()).toHaveLength(2);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ chatId: 'c81', type: 'channel' });
  });

  it('dedupes chats found both in own dialogs and the server search', async () => {
    const group = new MockChannel({ id: 82n, title: 'Dup Group', megagroup: true });
    mockGetDialogs.mockResolvedValueOnce([
      { entity: group, name: 'Dup Group', dialog: { unreadCount: 2 }, message: undefined },
    ]);
    routeInvoke({ contactsSearch: () => ({ users: [], chats: [group] }) });

    const result = await searchPeers(makeEntry() as any, 'dup');

    expect(result).toHaveLength(1);
    // The own-dialog entry wins so unread/lastMessage info is kept
    expect(result[0].unreadCount).toBe(2);
  });

  it('reuses the cached dialog list for consecutive searches on the same entry', async () => {
    routeInvoke();
    const entry = makeEntry();
    await searchPeers(entry as any, 'first');
    await searchPeers(entry as any, 'second');

    expect(mockGetDialogs).toHaveBeenCalledTimes(1);
  });
});

// ---- joinChannel -----------------------------------------------------------

describe('joinChannel', () => {
  const CHANNEL_PRIVATE = new Error('400: CHANNEL_PRIVATE (caused by channels.JoinChannel)');

  function makePrivateGroup() {
    return new MockChannel({
      id: 90n, title: 'Private Group', megagroup: true, left: true,
    });
  }

  it('joins directly when the channel is accessible', async () => {
    const group = makePrivateGroup();
    mockInvoke.mockImplementation(async (req: any) => {
      if ('joinChannel' in req) return {};
      throw new Error(`unexpected request ${JSON.stringify(req)}`);
    });

    const result = await joinChannel(makeEntry([['c90', group]]) as any, 'c90');

    expect(result).toEqual({ joined: true });
    expect((group as any).left).toBe(false);
  });

  it('recovers from CHANNEL_PRIVATE via a message reference, without any invite', async () => {
    const group = makePrivateGroup();
    const mentioningMsg = new MockMessage({
      id: 7,
      peerId: new MockPeerChannel({ channelId: 91n }),
      fwdFrom: { fromId: new MockPeerChannel({ channelId: 90n }) },
      message: 'forwarded from the group',
      date: 1700000000,
    });
    mockInvoke.mockImplementation(async (req: any) => {
      if ('joinChannel' in req) {
        // Direct join with the min entity fails; the message-derived reference works
        if (req.joinChannel?.fromMessage) return {};
        throw CHANNEL_PRIVATE;
      }
      if ('offsetRate' in req) return { messages: [mentioningMsg], chats: [], users: [] };
      throw new Error(`unexpected request ${JSON.stringify(req)}`);
    });

    const result = await joinChannel(makeEntry([['c90', group]]) as any, 'c90');

    expect(result).toEqual({ joined: true });
    expect((group as any).left).toBe(false);
  });

  it('recovers from CHANNEL_PRIVATE via an invite link found in messages', async () => {
    const group = makePrivateGroup();
    const linkMsg = new MockMessage({
      id: 8,
      peerId: new MockPeerChannel({ channelId: 91n }),
      message: 'join here https://t.me/+AbCdEf12345',
      date: 1700000000,
    });
    const imported: string[] = [];
    mockInvoke.mockImplementation(async (req: any) => {
      if ('joinChannel' in req) throw CHANNEL_PRIVATE;
      if ('offsetRate' in req) return { messages: [linkMsg], chats: [], users: [] };
      if ('checkHash' in req) {
        return new MockChatInvite({ title: 'Private Group', participantsCount: 11, megagroup: true });
      }
      if ('importHash' in req) {
        imported.push(req.importHash);
        return { chats: [new MockChannel({ id: 90n, title: 'Private Group', megagroup: true })] };
      }
      throw new Error(`unexpected request ${JSON.stringify(req)}`);
    });

    const result = await joinChannel(makeEntry([['c90', group]]) as any, 'c90');

    expect(result).toEqual({ joined: true });
    expect(imported).toEqual(['AbCdEf12345']);
  });

  it('skips invites that resolve to a different chat', async () => {
    const group = makePrivateGroup();
    const linkMsg = new MockMessage({
      id: 9,
      peerId: new MockPeerChannel({ channelId: 91n }),
      message: 'unrelated https://t.me/+WrongGroup99',
      date: 1700000000,
    });
    mockInvoke.mockImplementation(async (req: any) => {
      if ('joinChannel' in req) throw CHANNEL_PRIVATE;
      if ('offsetRate' in req) return { messages: [linkMsg], chats: [], users: [] };
      if ('checkHash' in req) {
        return new MockChatInvite({ title: 'A Different Group', participantsCount: 3 });
      }
      throw new Error(`unexpected request ${JSON.stringify(req)}`);
    });

    await expect(
      joinChannel(makeEntry([['c90', group]]) as any, 'c90'),
    ).rejects.toThrow('CHANNEL_PRIVATE');
  });

  it('rethrows CHANNEL_PRIVATE when nothing can be discovered', async () => {
    const group = makePrivateGroup();
    mockInvoke.mockImplementation(async (req: any) => {
      if ('joinChannel' in req) throw CHANNEL_PRIVATE;
      if ('offsetRate' in req) return { messages: [], chats: [], users: [] };
      throw new Error(`unexpected request ${JSON.stringify(req)}`);
    });

    await expect(
      joinChannel(makeEntry([['c90', group]]) as any, 'c90'),
    ).rejects.toThrow('CHANNEL_PRIVATE');
  });
});

// ---- subscribeToMessages ---------------------------------------------------

describe('subscribeToMessages', () => {
  it('returns a noop when no live client is cached for the account', () => {
    const sub = vi.fn();
    const unsub = subscribeToMessages(9999, sub);

    unsub(); // must not throw
    expect(sub).not.toHaveBeenCalled();
  });

  it('delivers live messages to the subscriber and stops after unsubscribe', async () => {
    await getLiveClient(400);

    const sub   = vi.fn();
    const unsub = subscribeToMessages(400, sub);

    // Grab the event handler registered with addEventHandler
    const [eventCb] = mockAddEventHandler.mock.calls[0];

    const peerId  = new MockPeerUser({ userId: 402n });
    const fromPeer = new MockPeerUser({ userId: 401n });

    eventCb({
      message: {
        id:          10,
        message:     'Incoming!',
        date:        1700000020,
        out:         false,
        peerId,
        fromId:      fromPeer,
        media:       null,
        replyMarkup: null,
      },
    });

    expect(sub).toHaveBeenCalledTimes(1);
    const liveMsg = sub.mock.calls[0][0];
    expect(liveMsg.chatId).toBe('u402');
    expect(liveMsg.message.text).toBe('Incoming!');
    expect(liveMsg.message.fromId).toBe('u401');

    // After unsub, further events must not reach the subscriber
    unsub();
    eventCb({
      message: {
        id: 11, message: 'After unsub', date: 1700000021,
        out: false, peerId, fromId: null, media: null, replyMarkup: null,
      },
    });

    expect(sub).toHaveBeenCalledTimes(1);
  });
});

describe('parseMiniAppLink', () => {
  it('parses a named mini app link with a plain start param', () => {
    expect(parseMiniAppLink('https://t.me/somebot/app?startapp=abc_DEF-123')).toEqual({
      botUsername: 'somebot',
      appShortName: 'app',
      startParam: 'abc_DEF-123',
    });
  });

  it('parses a main mini app link without an app short name', () => {
    const parsed = parseMiniAppLink('https://t.me/somebot?startapp=xyz');
    expect(parsed?.botUsername).toBe('somebot');
    expect(parsed?.appShortName).toBeUndefined();
    expect(parsed?.startParam).toBe('xyz');
  });

  it('percent-decodes the start param and strips base64 padding (issue: START_PARAM_INVALID)', () => {
    const parsed = parseMiniAppLink(
      'https://telegram.me/verifybot/panel?startapp=L3dlYi12ZXJpZnkvLTEwMDEyMzQ1Njc4OTAvMTIzNDU2Nzg5MA%3D%3D',
    );
    expect(parsed).toEqual({
      botUsername: 'verifybot',
      appShortName: 'panel',
      startParam: 'L3dlYi12ZXJpZnkvLTEwMDEyMzQ1Njc4OTAvMTIzNDU2Nzg5MA',
    });
  });

  it('keeps the raw value when percent-decoding fails', () => {
    const parsed = parseMiniAppLink('https://t.me/somebot/app?startapp=bad%zzvalue');
    expect(parsed?.startParam).toBe('bad%zzvalue');
  });

  // A named app needs no start parameter: plenty of apps have no context to be handed,
  // and their link is just t.me/<bot>/<app>.
  it('parses a named mini app link with no start param', () => {
    expect(parseMiniAppLink('https://t.me/zzmeb_bot/miniapp')).toEqual({
      botUsername: 'zzmeb_bot',
      appShortName: 'miniapp',
    });
  });

  it('leaves the start param off rather than sending an empty one', () => {
    expect(parseMiniAppLink('https://t.me/somebot/app?startapp=')).toEqual({
      botUsername: 'somebot',
      appShortName: 'app',
    });
  });

  it('returns null for non-mini-app links', () => {
    expect(parseMiniAppLink('https://t.me/somebot?start=abc')).toBeNull();
    expect(parseMiniAppLink('https://example.com/?startapp=abc')).toBeNull();
  });

  // Without an app name or a start param there is no app in the link, only a bot -- and a
  // message link (t.me/channel/123) is not one either.
  it('does not claim a bare bot or channel link', () => {
    expect(parseMiniAppLink('https://t.me/somebot')).toBeNull();
    expect(parseMiniAppLink('https://t.me/somechannel/1234')).toBeNull();
  });
});

// ---- fetchPhoto size cap ---------------------------------------------------

describe('fetchPhoto', () => {
  // The whole file is buffered to serve it, so an oversized document has to be
  // refused before the download rather than spiking the heap by its full size.
  function mediaMessage(sizeBytes: number) {
    return new MockMessage({
      id: 5,
      media: new MockMessageMediaDocument({
        document: new MockDocument({ size: sizeBytes, mimeType: 'video/mp4' }),
      }),
    });
  }

  it('refuses a document larger than the inline limit without downloading it', async () => {
    const entry = await getLiveClient(700);
    entry.entityCache.set('u1', new MockUser({ id: 1n }) as any);
    mockGetMessages.mockResolvedValueOnce([mediaMessage(80 * 1024 * 1024)]);

    expect(await fetchPhoto(entry as any, 'u1', 5)).toBeNull();
    expect(mockClientInstance.downloadMedia).not.toHaveBeenCalled();
  });

  it('serves a document within the limit', async () => {
    const entry = await getLiveClient(701);
    entry.entityCache.set('u1', new MockUser({ id: 1n }) as any);
    mockGetMessages.mockResolvedValueOnce([mediaMessage(2 * 1024 * 1024)]);
    mockClientInstance.downloadMedia.mockResolvedValueOnce(Buffer.from('abc'));

    const result = await fetchPhoto(entry as any, 'u1', 5);
    expect(result?.mimeType).toBe('video/mp4');
    expect(result?.buf.toString()).toBe('abc');
  });
});

// ---- sweepLiveClients (issue #14: memory growth) ----------------------------

describe('normalisePhoneNumber', () => {
  it('strips a leading + and cosmetic separators', () => {
    expect(normalisePhoneNumber('+61 412 345 678')).toBe('61412345678');
    expect(normalisePhoneNumber('(02) 5550-1234')).toBe('0255501234');
  });

  it('rejects anything that is not a plausible number', () => {
    expect(normalisePhoneNumber('not a number')).toBeNull();
    expect(normalisePhoneNumber('1234')).toBeNull();          // too short
    expect(normalisePhoneNumber('1'.repeat(21))).toBeNull();  // too long
    expect(normalisePhoneNumber('+61-412-345-678x99')).toBeNull();
    expect(normalisePhoneNumber('')).toBeNull();
  });
});

describe('sweepLiveClients', () => {
  const IDLE_MS = 30 * 60_000;

  // The liveClients map is module-level, so entries from earlier tests leak
  // into these ones. Evict every idle leftover, then reset the counters the
  // assertions below rely on.
  beforeEach(() => {
    sweepLiveClients(Date.now() + IDLE_MS * 1000);
    mockClientInstance.destroy.mockClear();
    MockTelegramClient.mockClear();
  });

  it('destroys and evicts a client left idle past the threshold', async () => {
    await getLiveClient(400);

    sweepLiveClients(Date.now() + IDLE_MS + 1);

    expect(mockClientInstance.destroy).toHaveBeenCalledTimes(1);
    // Next request builds a fresh client instead of reusing the evicted entry
    await getLiveClient(400);
    expect(MockTelegramClient).toHaveBeenCalledTimes(2);
  });

  it('keeps a client alive while it has subscribers', async () => {
    await getLiveClient(401);
    const unsubscribe = subscribeToMessages(401, () => {});

    sweepLiveClients(Date.now() + IDLE_MS * 10);

    expect(mockClientInstance.destroy).not.toHaveBeenCalled();
    await getLiveClient(401);
    expect(MockTelegramClient).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('evicts once the last subscriber is gone and the idle window elapses', async () => {
    await getLiveClient(402);
    const unsubscribe = subscribeToMessages(402, () => {});

    // Subscribed sweep refreshes the idle window rather than evicting
    const later = Date.now() + IDLE_MS * 10;
    sweepLiveClients(later);
    unsubscribe();

    sweepLiveClients(later + IDLE_MS - 1);
    expect(mockClientInstance.destroy).not.toHaveBeenCalled();

    sweepLiveClients(later + IDLE_MS + 1);
    expect(mockClientInstance.destroy).toHaveBeenCalledTimes(1);
  });

  // LIVE_CLIENT_MAX defaults to 8. On a small host it is the number of connected
  // accounts, not idle time, that exhausts memory, so the cap has to bite before
  // the idle window elapses.
  it('evicts the least recently used client once over LIVE_CLIENT_MAX', async () => {
    for (let i = 0; i < 9; i++) await getLiveClient(500 + i);

    // The 9th admission pushes the registry over the cap and drops the oldest
    expect(mockClientInstance.destroy).toHaveBeenCalledTimes(1);

    // The evicted one is rebuilt on next use; the most recent is still cached
    MockTelegramClient.mockClear();
    await getLiveClient(500);
    expect(MockTelegramClient).toHaveBeenCalledTimes(1);
    MockTelegramClient.mockClear();
    await getLiveClient(508);
    expect(MockTelegramClient).not.toHaveBeenCalled();
  });

  it('never evicts a watched client, even when that leaves the cap exceeded', async () => {
    const unsubscribes = [];
    for (let i = 0; i < 10; i++) {
      await getLiveClient(600 + i);
      unsubscribes.push(subscribeToMessages(600 + i, () => {}));
    }

    // Every entry has a subscriber, so there is nothing eligible to drop
    expect(mockClientInstance.destroy).not.toHaveBeenCalled();

    // Dropping the subscribers makes them evictable again on the next sweep
    unsubscribes.forEach((u) => u());
    sweepLiveClients(Date.now());
    expect(mockClientInstance.destroy).toHaveBeenCalled();
  });

  it('trims oversized caches on a live entry without evicting it', async () => {
    const entry = await getLiveClient(403);
    subscribeToMessages(403, () => {});
    for (let i = 0; i < 1200; i++) {
      entry.entityCache.set(`u${i}`, {} as any);
    }

    sweepLiveClients(Date.now());

    expect(entry.entityCache.size).toBe(1000);
    // Oldest insertions are dropped first
    expect(entry.entityCache.has('u0')).toBe(false);
    expect(entry.entityCache.has('u1199')).toBe(true);
    expect(mockClientInstance.destroy).not.toHaveBeenCalled();
  });
});
