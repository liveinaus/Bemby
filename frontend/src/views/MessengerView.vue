<template>
  <div class="tgc-page">
    <div
      class="tgc-popup tgc-popup-inline"
      :class="{ 'mobile-chat-open': showMobileChat }"
    >
      <!-- Header -->
      <div class="tgc-header">
        <div class="tgc-header-left">
          <svg
            class="tgc-logo"
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="currentColor"
            width="20"
            height="20"
          >
            <path
              d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.562 8.248-2.018 9.51c-.145.658-.537.818-1.084.508l-3-2.21-1.447 1.394c-.16.16-.295.295-.605.295l.213-3.053 5.56-5.023c.242-.213-.054-.333-.373-.12l-6.871 4.326-2.962-.924c-.643-.204-.657-.643.136-.953l11.57-4.461c.537-.194 1.006.131.881.71z"
            />
          </svg>
          <span class="tgc-title">Messenger</span>
          <select
            v-model="selectedAccountId"
            class="tgc-account-select"
            @change="onAccountChange"
          >
            <option
              v-for="acc in authenticatedAccounts"
              :key="acc.id"
              :value="acc.id"
            >
              {{ formatAccountLabel(acc) }}
            </option>
          </select>
        </div>
        <div class="tgc-header-right">
          <button
            class="tgc-icon-btn"
            :title="t('tgc.clearAccountCache')"
            :disabled="!selectedAccountId || clearingCache"
            @click="onClearAccountCache"
          >
            <i class="fa-solid fa-eraser"></i>
          </button>
          <button
            class="tgc-icon-btn tgc-clean-btn"
            :title="t('tgc.clean.btnTitle')"
            :disabled="!selectedAccountId"
            @click="openCleanConfirm"
          >
            <i class="fa-solid fa-broom"></i>
          </button>
          <button
            class="tgc-icon-btn"
            title="Contacts"
            @click="showContacts = true"
          >
            <i class="fa-solid fa-address-book"></i>
          </button>
        </div>
      </div>

      <!-- Body -->
      <div class="tgc-body" :class="{ 'chat-open': showMobileChat }">
        <!-- Sidebar: dialog list -->
        <div class="tgc-sidebar">
          <div class="tgc-search-wrap">
            <i class="fa-solid fa-magnifying-glass tgc-search-icon"></i>
            <input
              v-model="searchQuery"
              class="tgc-search-input"
              placeholder="Search chats..."
              @input="onSearchInput"
            />
            <button
              v-if="searchQuery"
              class="tgc-search-clear"
              @click="clearSearch"
            >
              <i class="fa-solid fa-xmark"></i>
            </button>
          </div>

          <div v-if="tgFolders.length" class="tgc-folder-tabs-wrap">
            <div class="tgc-folder-tabs">
              <button
                class="tgc-folder-tab"
                :class="{ active: activeFolder === 'all' }"
                @click="activeFolder = 'all'"
              >
                All
              </button>
              <button
                v-for="f in tgFolders"
                :key="f.id"
                class="tgc-folder-tab"
                :class="{ active: activeFolder === f.id }"
                @click="activeFolder = f.id"
              >
                {{ f.emoticon ? f.emoticon + " " : "" }}{{ f.title }}
              </button>
            </div>
          </div>

          <div class="tgc-dialog-list">
            <div v-if="loadingDialogs" class="tgc-spinner-wrap">
              <span class="tgc-spinner"></span>
            </div>
            <div v-else-if="dialogError" class="tgc-list-error">
              <i
                class="fa-solid fa-triangle-exclamation tgc-list-error-icon"
              ></i>
              <span>{{ dialogError }}</span>
              <button
                class="tgc-reconnect-btn"
                :disabled="reconnecting"
                @click="reconnectAccount"
              >
                <span v-if="reconnecting"
                  ><span class="tgc-spinner tgc-spinner-sm"></span>
                  Reconnecting...</span
                >
                <span v-else
                  ><i class="fa-solid fa-rotate-right"></i> Reconnect</span
                >
              </button>
            </div>
            <template v-else>
              <div
                v-for="d in displayedDialogs"
                :key="d.chatId"
                class="tgc-dialog-item"
                :class="{ active: activeChatId === d.chatId }"
                @click="openChat(d)"
                @contextmenu="onDialogContextMenu($event, d)"
                @touchstart.passive="onDialogTouchStart($event, d)"
                @touchend.passive="onDialogTouchEnd"
                @touchmove.passive="onDialogTouchEnd"
              >
                <div class="tgc-avatar" :class="`tgc-avatar-${d.type}`" v-avatar-load="d.chatId">
                  <img
                    v-if="avatarSrc(d.chatId)"
                    :src="avatarSrc(d.chatId)"
                    class="tgc-avatar-photo"
                    alt=""
                  />
                  {{ avatarLetter(d.name) }}
                </div>
                <div class="tgc-dialog-info">
                  <div class="tgc-dialog-row">
                    <span class="tgc-dialog-name">{{ d.name }}</span>
                    <span class="tgc-dialog-time">{{
                      d.lastMessage ? fmtTime(d.lastMessage.date) : ""
                    }}</span>
                  </div>
                  <div class="tgc-dialog-row">
                    <span
                      v-if="searchQuery"
                      class="tgc-dialog-preview tgc-dialog-username"
                      >{{ d.username ? "@" + d.username : "" }}</span
                    >
                    <span
                      v-else-if="isTyping(d.chatId)"
                      class="tgc-dialog-preview tgc-typing"
                      >{{ typingLabel(d.chatId) }}</span
                    >
                    <span v-else class="tgc-dialog-preview">{{
                      d.lastMessage?.text || ""
                    }}</span>
                    <i v-if="d.pinned && !d.unreadCount" class="fa-solid fa-thumbtack tgc-pin-icon"></i>
                    <span v-if="d.unreadCount > 0" class="tgc-unread-badge">{{
                      d.unreadCount
                    }}</span>
                  </div>
                </div>
              </div>
              <div
                v-if="searchQuery && searchLoading && !displayedDialogs.length"
                class="tgc-empty-list"
              >
                <span class="tgc-spinner tgc-spinner-sm"></span>
                Searching Telegram...
              </div>
              <div
                v-else-if="searchQuery && searchError"
                class="tgc-empty-list"
              >
                {{ searchError }}
              </div>
              <div
                v-else-if="!displayedDialogs.length && !loadingDialogs"
                class="tgc-empty-list"
              >
                No chats found
              </div>
            </template>
          </div>
        </div>

        <!-- Chat + profile panel -->
        <template v-if="activeChat">
          <div class="tgc-chat">
            <!-- Mini App overlay panel -->
            <div v-if="webViewPanel" class="tgc-webview-overlay">
              <div class="tgc-webview-header">
                <span class="tgc-webview-title">{{ webViewPanel.title }}</span>
                <button
                  class="tgc-icon-btn"
                  @click="webViewPanel = null"
                  title="Close"
                >
                  <i class="fa-solid fa-xmark"></i>
                </button>
              </div>
              <div v-if="webViewPanel.proxied" class="tgc-webview-proxy-note">
                <i class="fa-solid fa-shield-halved"></i>
                {{ t("tgc.openLink.proxiedNote") }}
              </div>
              <!-- A proxied page served from Bemby's own origin must NOT get
                   allow-same-origin: it would let site scripts reach Bemby's
                   storage and auth token. One on the viewer origin is a different
                   origin already, so it can have a real origin of its own --
                   which is what gives it working storage, cookies and crypto -->
              <iframe
                :src="webViewPanel.url"
                class="tgc-webview-frame"
                :sandbox="
                  webViewPanel.proxied && !webViewPanel.isolated
                    ? 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox'
                    : 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox'
                "
                allow="camera; microphone; geolocation"
                @load="onWebViewLoad"
              ></iframe>
            </div>

            <div class="tgc-chat-header">
              <button
                v-show="showMobileChat || chatNavStack.length > 0"
                class="tgc-back-btn"
                @click="backToDialogs"
                title="Back to chats"
              >
                <i class="fa-solid fa-arrow-left"></i>
                <span class="tgc-back-label">Back</span>
              </button>
              <div
                class="tgc-avatar tgc-avatar-sm tgc-clickable"
                :class="`tgc-avatar-${activeChat.type}`"
                v-avatar-load="activeChat.chatId"
                @click="openProfile"
              >
                <img
                  v-if="avatarSrc(activeChat.chatId)"
                  :src="avatarSrc(activeChat.chatId)"
                  class="tgc-avatar-photo"
                  alt=""
                />
                {{ avatarLetter(activeChat.name) }}
              </div>
              <div
                class="tgc-chat-title-wrap tgc-clickable"
                @click="openProfile"
              >
                <div class="tgc-chat-name">{{ activeChat.name }}</div>
                <div
                  class="tgc-chat-sub tgc-typing"
                  v-if="isTyping(activeChat.chatId)"
                >
                  {{ typingLabel(activeChat.chatId) }}
                </div>
                <div class="tgc-chat-sub" v-else-if="activeChat.username">
                  @{{ activeChat.username }}
                </div>
              </div>
              <div class="tgc-chat-actions">
                <button
                  class="tgc-icon-btn"
                  :class="{ 'tgc-icon-btn--active': msgSearchOpen }"
                  @click="toggleMsgSearch"
                  :title="t('tgc.searchMessages')"
                >
                  <i class="fa-solid fa-magnifying-glass"></i>
                </button>
                <button
                  class="tgc-icon-btn"
                  @click="clearChatCache"
                  :title="t('tgc.clearCache')"
                >
                  <i class="fa-solid fa-arrows-rotate"></i>
                </button>
                <button
                  class="tgc-icon-btn"
                  :class="{ 'tgc-icon-btn--active': openMiniAppInApp }"
                  @click="openMiniAppInApp = !openMiniAppInApp"
                  :title="openMiniAppInApp ? t('tgc.miniAppInApp') : t('tgc.miniAppInBrowser')"
                >
                  <i class="fa-solid fa-puzzle-piece"></i>
                </button>
                <button
                  class="tgc-icon-btn"
                  @click="openGoUrlDialog"
                  :title="t('tgc.openUrl')"
                >
                  <i class="fa-solid fa-globe"></i>
                </button>
                <button
                  class="tgc-icon-btn tgc-chat-close-btn"
                  @click="closeChat"
                  :title="t('tgc.closeChat')"
                >
                  <i class="fa-solid fa-xmark"></i>
                </button>
              </div>
              <!-- Mobile: all header actions collapse into a single menu -->
              <button
                class="tgc-icon-btn tgc-chat-menu-btn"
                :class="{ 'tgc-icon-btn--active': chatMenuOpen }"
                @click="toggleChatMenu"
                :title="t('tgc.chatActions')"
              >
                <i class="fa-solid fa-ellipsis-vertical"></i>
              </button>
            </div>

            <!-- In-chat message search -->
            <div v-if="msgSearchOpen" class="tgc-msg-search">
              <div class="tgc-msg-search-bar">
                <i class="fa-solid fa-magnifying-glass tgc-msg-search-icon"></i>
                <input
                  ref="msgSearchInputEl"
                  v-model="msgSearchQuery"
                  class="tgc-msg-search-input"
                  :placeholder="t('tgc.searchPlaceholder')"
                  @keydown.enter="runMsgSearch"
                  @keydown.esc="closeMsgSearch"
                />
                <button
                  class="tgc-icon-btn"
                  :disabled="msgSearchLoading || !msgSearchQuery.trim()"
                  @click="runMsgSearch"
                  :title="t('tgc.searchMessages')"
                >
                  <span v-if="msgSearchLoading" class="tgc-spinner"></span>
                  <i v-else class="fa-solid fa-arrow-right"></i>
                </button>
                <button class="tgc-icon-btn" @click="closeMsgSearch" title="Close">
                  <i class="fa-solid fa-xmark"></i>
                </button>
              </div>
              <div
                v-if="msgSearchDone && msgSearchResults.length === 0"
                class="tgc-msg-search-empty"
              >
                {{ t('tgc.searchNoResults') }}
              </div>
              <div v-else-if="msgSearchResults.length" class="tgc-msg-search-results">
                <div
                  v-for="r in msgSearchResults"
                  :key="r.id"
                  class="tgc-msg-search-row"
                  role="button"
                  tabindex="0"
                  @click="openMsgSearchResult(r)"
                  @keydown.enter="openMsgSearchResult(r)"
                >
                  <span class="tgc-msg-search-from">{{ r.fromMe ? t('tgc.searchYou') : (r.fromName || activeChat.name) }}</span>
                  <span class="tgc-msg-search-text">{{ r.text }}</span>
                  <span class="tgc-msg-search-date">{{ fmtTime(r.date) }}</span>
                </div>
              </div>
            </div>

            <!-- Pinned message banner -->
            <div
              v-if="pinnedMsg"
              class="tgc-pinned-bar"
              @click="jumpToPinned"
              role="button"
              tabindex="0"
              @keydown.enter="jumpToPinned"
            >
              <i class="fa-solid fa-thumbtack tgc-pinned-icon"></i>
              <div class="tgc-pinned-content">
                <span class="tgc-pinned-label">Pinned Message</span>
                <span class="tgc-pinned-text">{{ pinnedMsg.text }}</span>
              </div>
            </div>

            <div
              class="tgc-messages"
              ref="messagesEl"
              @scroll="onMsgScroll"
              @click="activeMsgId = null"
            >
              <div v-if="loadingOlder" class="tgc-load-more">
                <span class="tgc-spinner"></span>
              </div>
              <div
                v-if="loadingMessages"
                class="tgc-spinner-wrap"
                style="height: 100%"
              >
                <span class="tgc-spinner"></span>
              </div>
              <template v-else>
                <div
                  v-for="(msg, idx) in messages"
                  :key="msg.id"
                  :data-msg-id="msg.id"
                >
                  <!-- Date separator -->
                  <div
                    v-if="
                      idx === 0 || !sameDay(messages[idx - 1].date, msg.date)
                    "
                    class="tgc-date-sep"
                  >
                    {{ fmtDate(msg.date) }}
                  </div>

                  <!-- Unread messages marker -->
                  <div
                    v-if="firstUnreadId !== null && msg.id === firstUnreadId"
                    class="tgc-unread-sep"
                  >
                    Unread messages
                  </div>

                  <!-- Service notice (joined, left, renamed...) -->
                  <div v-if="msg.service" class="tgc-service-msg">
                    <span>{{ serviceText(msg) }}</span>
                  </div>

                  <div
                    v-else
                    class="tgc-msg-wrap"
                    :class="[
                      msg.fromMe ? 'tgc-msg-out' : 'tgc-msg-in',
                      {
                        'tgc-msg-active': activeMsgId === msg.id,
                        'tgc-msg-selectable': selectMode,
                        'tgc-msg-selected':
                          selectMode && selectedMsgIds.has(msg.id),
                      },
                    ]"
                    @click="selectMode && toggleSelectMsg(msg)"
                  >
                    <!-- Sender avatar (groups only; anonymous senders fall back to the group icon) -->
                    <template v-if="!msg.fromMe && activeChat.type === 'group'">
                      <div
                        v-if="showSenderAvatar(idx)"
                        class="tgc-sender-av"
                        :style="!avatarSrc(senderAvatarId(msg)) ? { background: senderColor(senderAvatarId(msg)) } : {}"
                        :title="senderLabel(msg) || ''"
                        v-avatar-load="senderAvatarId(msg)"
                      >
                        <img
                          v-if="avatarSrc(senderAvatarId(msg))"
                          :src="avatarSrc(senderAvatarId(msg))"
                          class="tgc-sender-av-photo"
                          alt=""
                        />
                        <template v-else>{{ avatarLetter(senderLabel(msg) || "?") }}</template>
                      </div>
                      <div v-else class="tgc-sender-av-ph"></div>
                    </template>

                    <!-- Selection tick -->
                    <div
                      v-if="selectMode"
                      class="tgc-msg-select-tick"
                      :class="{ checked: selectedMsgIds.has(msg.id) }"
                    >
                      <i class="fa-solid fa-check"></i>
                    </div>

                    <!-- Hover action bar -->
                    <div v-if="!selectMode" class="tgc-msg-actions">
                      <button
                        class="tgc-msg-action"
                        title="Reply"
                        @click.stop="startReply(msg)"
                      >
                        <i class="fa-solid fa-reply"></i>
                      </button>
                      <button
                        class="tgc-msg-action"
                        title="React"
                        @click.stop="openReactPicker(msg, $event)"
                      >
                        <i class="fa-regular fa-face-smile"></i>
                      </button>
                      <button
                        v-if="msg.replyCount"
                        class="tgc-msg-action"
                        title="View thread"
                        @click.stop="openThread(msg)"
                      >
                        <i class="fa-regular fa-comment"></i>
                      </button>
                      <button
                        class="tgc-msg-action"
                        title="Forward"
                        @click.stop="openForward(msg)"
                      >
                        <i class="fa-solid fa-share"></i>
                      </button>
                      <button
                        v-if="msg.fromMe && msg.text && !msg.hasPhoto && !msg.hasDocument && !msg.hasSticker"
                        class="tgc-msg-action"
                        title="Edit"
                        @click.stop="startEditMessage(msg)"
                      >
                        <i class="fa-solid fa-pen"></i>
                      </button>
                      <button
                        class="tgc-msg-action"
                        title="Delete"
                        @click.stop="openDeleteMsg(msg)"
                      >
                        <i class="fa-solid fa-trash-can"></i>
                      </button>
                      <button
                        class="tgc-msg-action"
                        title="Select"
                        @click.stop="enterSelectMode(msg)"
                      >
                        <i class="fa-regular fa-square-check"></i>
                      </button>
                    </div>

                    <div
                      class="tgc-msg-bubble"
                      @click.stop="onBubbleClick(msg)"
                    >
                      <div
                        v-if="
                          !msg.fromMe &&
                          activeChat.type !== 'user' &&
                          activeChat.type !== 'bot' &&
                          senderLabel(msg)
                        "
                        class="tgc-msg-sender"
                      >
                        {{ senderLabel(msg) }}
                      </div>
                      <!-- Reply quote -->
                      <div
                        v-if="msg.replyToId"
                        class="tgc-reply-quote"
                        @click.stop="scrollToReply(msg.replyToId)"
                      >
                        <div class="tgc-reply-bar"></div>
                        <div class="tgc-reply-content">
                          <div class="tgc-reply-name">
                            {{ msg.replyToName || "Message" }}
                          </div>
                          <div class="tgc-reply-text">
                            {{ msg.replyToText || "..." }}
                          </div>
                        </div>
                      </div>
                      <img
                        v-if="msg.hasPhoto"
                        :src="photoUrl(msg.id)"
                        class="tgc-msg-photo"
                        loading="lazy"
                        @click="lightboxUrl = photoUrl(msg.id)"
                        @error="
                          (e: Event) =>
                            ((e.target as HTMLImageElement).style.display =
                              'none')
                        "
                      />
                      <img
                        v-if="msg.hasSticker"
                        :src="photoUrl(msg.id)"
                        class="tgc-msg-sticker"
                        loading="lazy"
                        @error="
                          (e: Event) =>
                            ((e.target as HTMLImageElement).style.display =
                              'none')
                        "
                      />
                      <a
                        v-if="msg.hasDocument"
                        class="tgc-msg-doc"
                        :href="photoUrl(msg.id)"
                        :download="msg.fileName || 'file'"
                        target="_blank"
                        rel="noopener"
                      >
                        <i
                          class="fa-solid fa-file-arrow-down tgc-msg-doc-icon"
                        ></i>
                        <span class="tgc-msg-doc-name">{{
                          msg.fileName || "File"
                        }}</span>
                      </a>
                      <div
                        v-if="msg.text || msg.html"
                        class="tgc-msg-text"
                        v-html="msg.html ?? escMsgText(msg.text)"
                        @click="onMsgLinkClick($event)"
                      ></div>
                      <!-- Reactions -->
                      <div v-if="msg.reactions?.length" class="tgc-reactions">
                        <button
                          v-for="r in msg.reactions"
                          :key="r.emoji"
                          class="tgc-reaction"
                          :class="{ 'tgc-reaction-mine': r.mine }"
                          @click.stop="doReact(msg.id, r.emoji)"
                        >
                          {{ r.emoji }}
                          <span class="tgc-reaction-count">{{ r.count }}</span>
                        </button>
                      </div>
                      <div class="tgc-msg-meta">
                        <!-- Comment count -->
                        <button
                          v-if="msg.replyCount"
                          class="tgc-comment-btn"
                          @click.stop="openThread(msg)"
                        >
                          <i class="fa-regular fa-comment"></i>
                          {{ msg.replyCount }}
                        </button>
                        <span class="tgc-msg-time">{{
                          fmtMsgTime(msg.date)
                        }}</span>
                        <i
                          v-if="msg.fromMe"
                          :class="['fa-solid', msg.isRead ? 'fa-check-double' : 'fa-check', 'tgc-msg-tick']"
                        ></i>
                      </div>
                      <!-- Inline keyboard buttons -->
                      <div v-if="msg.buttons" class="tgc-msg-buttons">
                        <div
                          v-for="(row, ri) in msg.buttons"
                          :key="ri"
                          class="tgc-btn-row"
                        >
                          <button
                            v-for="(btn, bi) in row"
                            :key="bi"
                            class="tgc-btn-chip"
                            :class="{
                              'tgc-btn-loading':
                                btnLoadingKey === `${msg.id}-${ri}-${bi}`,
                            }"
                            :disabled="
                              (!btn.data &&
                                !btn.url &&
                                !btn.send &&
                                !btn.requestPhone) ||
                              btnLoadingKey === `${msg.id}-${ri}-${bi}`
                            "
                            @click="clickInlineButton(msg, btn, ri, bi)"
                          >
                            {{ btn.text }}
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
                <div v-if="!messages.length" class="tgc-empty-chat">
                  No messages yet
                </div>
              </template>

              <!-- Floating jump-to-latest button -->
              <div v-show="jumpBtnVisible" class="tgc-jump-anchor">
                <button
                  class="tgc-jump-btn"
                  :title="t('tgc.jumpToLatest')"
                  @click.stop="jumpToLatest"
                >
                  <span v-if="jumpUnseenCount" class="tgc-jump-badge">{{
                    jumpUnseenCount > 99 ? "99+" : jumpUnseenCount
                  }}</span>
                  <i class="fa-solid fa-chevron-down"></i>
                </button>
              </div>
            </div>

            <!-- Command suggestions -->
            <div v-if="commandSuggestions.length" class="tgc-cmd-suggestions">
              <div
                v-for="(cmd, i) in commandSuggestions"
                :key="cmd.command"
                class="tgc-cmd-item"
                :class="{ 'tgc-cmd-selected': i === selectedCmdIdx }"
                @click="selectCommand(cmd)"
              >
                <span class="tgc-cmd-name">/{{ cmd.command }}</span>
                <span class="tgc-cmd-desc">{{ cmd.description }}</span>
              </div>
            </div>

            <!-- Multi-select action bar (replaces composer while selecting) -->
            <div v-if="selectMode" class="tgc-select-bar">
              <button
                class="tgc-icon-btn"
                title="Cancel selection"
                @click="exitSelectMode"
              >
                <i class="fa-solid fa-xmark"></i>
              </button>
              <span class="tgc-select-count">
                {{ selectedMsgIds.size }} selected
              </span>
              <div class="tgc-select-actions">
                <button
                  class="tgc-select-btn"
                  :disabled="!selectedMsgIds.size"
                  @click="openForwardSelected"
                >
                  <i class="fa-solid fa-share"></i> Forward
                </button>
                <button
                  class="tgc-select-btn tgc-select-danger"
                  :disabled="!selectedMsgIds.size"
                  @click="openDeleteSelected"
                >
                  <i class="fa-solid fa-trash-can"></i> Delete
                </button>
              </div>
            </div>

            <!-- Join bar shown when the user is not a member -->
            <div v-else-if="activeChat?.left" class="tgc-join-bar">
              <template v-if="joinRequestSent">
                <div class="tgc-join-pending">
                  <i class="fa-solid fa-clock"></i>
                  <span
                    >Complete the verification task -- check the chat above or a private message from the group bot.</span
                  >
                </div>
                <button
                  class="tgc-join-check-btn"
                  @click="checkMembershipStatus(); refreshMessages()"
                >
                  <i class="fa-solid fa-rotate"></i> Check now
                </button>
              </template>
              <button
                v-else
                class="tgc-join-btn"
                :disabled="joiningChannel"
                @click="joinCurrentChat"
              >
                <span v-if="joiningChannel">
                  <span class="tgc-spinner tgc-spinner-sm"></span> Joining...
                </span>
                <span v-else>
                  <i class="fa-solid fa-right-to-bracket"></i>
                  {{ activeChat?.type === "channel" ? "Subscribe" : "Join Group" }}
                </span>
              </button>
            </div>

            <div v-else class="tgc-compose">
              <!-- Edit strip -->
              <div v-if="editingMsg" class="tgc-reply-strip">
                <i class="fa-solid fa-pen tgc-reply-strip-icon"></i>
                <div class="tgc-reply-strip-body">
                  <div class="tgc-reply-strip-name">Edit message</div>
                  <div class="tgc-reply-strip-text">
                    {{ editingMsg.text || "..." }}
                  </div>
                </div>
                <button
                  class="tgc-icon-btn"
                  @click="cancelEditMessage"
                  title="Cancel edit"
                >
                  <i class="fa-solid fa-xmark"></i>
                </button>
              </div>
              <!-- Reply strip -->
              <div v-if="replyingTo && !editingMsg" class="tgc-reply-strip">
                <i class="fa-solid fa-reply tgc-reply-strip-icon"></i>
                <div class="tgc-reply-strip-body">
                  <div class="tgc-reply-strip-name">
                    {{ replyingTo.fromName || "Message" }}
                  </div>
                  <div class="tgc-reply-strip-text">
                    {{ replyingTo.text || "..." }}
                  </div>
                </div>
                <button
                  class="tgc-icon-btn"
                  @click="replyingTo = null"
                  title="Cancel reply"
                >
                  <i class="fa-solid fa-xmark"></i>
                </button>
              </div>
              <!-- Pending attachment preview -->
              <div v-if="pendingFile" class="tgc-attach-strip">
                <img
                  v-if="pendingPreviewUrl"
                  :src="pendingPreviewUrl"
                  class="tgc-attach-thumb"
                />
                <i v-else class="fa-solid fa-file tgc-attach-icon"></i>
                <div class="tgc-attach-info">
                  <div class="tgc-attach-name">{{ pendingFile.name }}</div>
                  <label class="tgc-attach-asdoc">
                    <input type="checkbox" v-model="sendAsDocument" />
                    Send as file
                  </label>
                </div>
                <button
                  class="tgc-icon-btn"
                  @click="clearPendingFile"
                  title="Remove attachment"
                >
                  <i class="fa-solid fa-xmark"></i>
                </button>
              </div>
              <div class="tgc-compose-row">
                <!-- Commands button for bots -->
                <button
                  v-if="botCommands.length"
                  class="tgc-slash-btn"
                  :class="{ active: commandSuggestions.length }"
                  title="Bot commands"
                  @click="openCommandMenu"
                >
                  /
                </button>
                <button
                  v-if="botMenuButton"
                  class="tgc-menu-app-btn"
                  :title="botMenuButton.text"
                  @click="openBotMenuApp"
                >
                  <i class="fa-regular fa-window-maximize"></i>
                  <span class="tgc-menu-app-text">{{ botMenuButton.text }}</span>
                </button>
                <button
                  class="tgc-attach-btn"
                  title="Attach photo or file"
                  @click="triggerFilePick"
                >
                  <i class="fa-solid fa-paperclip"></i>
                </button>
                <input
                  ref="fileInput"
                  type="file"
                  style="display: none"
                  @change="onFileSelected"
                />
                <textarea
                  v-model="inputText"
                  class="tgc-input"
                  :placeholder="pendingFile ? 'Add a caption...' : 'Write a message...'"
                  rows="1"
                  @keydown="onComposeKey"
                  @paste="onPaste"
                  @compositionstart="composing = true"
                  @compositionend="composing = false"
                  @input="onComposeInput"
                  ref="inputEl"
                ></textarea>
                <button
                  class="tgc-send-btn"
                  :disabled="(!inputText.trim() && !pendingFile) || sending"
                  @click="sendMessage"
                  title="Send (Enter)"
                >
                  <i class="fa-solid fa-paper-plane"></i>
                </button>
              </div>
            </div>
          </div>

          <!-- Profile info panel / Thread panel (flex sibling of chat) -->
          <div v-if="showProfile && !showThread" class="tgc-profile-panel">
            <div class="tgc-profile-header">
              <span class="tgc-profile-title">Info</span>
              <div style="display:flex;gap:4px;align-items:center">
                <button
                  v-if="profileDetails && (profileDetails.type === 'user' || profileDetails.type === 'bot') && !editingContact"
                  class="tgc-icon-btn"
                  title="Edit contact"
                  @click="startEditContact"
                >
                  <i class="fa-solid fa-pen"></i>
                </button>
                <button class="tgc-icon-btn" @click="showProfile = false">
                  <i class="fa-solid fa-xmark"></i>
                </button>
              </div>
            </div>

            <div v-if="profileLoading" class="tgc-spinner-wrap" style="flex: 1">
              <span class="tgc-spinner"></span>
            </div>
            <div v-else-if="profileDetails" class="tgc-profile-body">
              <div class="tgc-profile-avatar-wrap">
                <div
                  class="tgc-profile-avatar"
                  :class="`tgc-avatar-${profileDetails.type}`"
                  v-avatar-load="profileDetails.chatId"
                >
                  <img
                    v-if="avatarSrc(profileDetails.chatId)"
                    :src="avatarSrc(profileDetails.chatId)"
                    class="tgc-avatar-photo"
                    alt=""
                  />
                  {{ avatarLetter(profileDetails.name) }}
                </div>
                <div class="tgc-profile-name">{{ profileDetails.name }}</div>
                <div class="tgc-profile-type-badge">
                  {{ profileDetails.type }}
                </div>
              </div>

              <!-- Inline contact edit form -->
              <div v-if="editingContact" class="tgc-contact-edit-form">
                <input
                  v-model="editFirstName"
                  class="tgc-input tgc-contact-edit-input"
                  placeholder="First name"
                  :disabled="savingContact"
                  @keydown.enter.exact.prevent="saveContactEdit"
                  @keydown.esc.prevent="editingContact = false"
                />
                <input
                  v-model="editLastName"
                  class="tgc-input tgc-contact-edit-input"
                  placeholder="Last name"
                  :disabled="savingContact"
                  @keydown.enter.exact.prevent="saveContactEdit"
                  @keydown.esc.prevent="editingContact = false"
                />
                <div class="tgc-contact-edit-actions">
                  <button
                    class="tgc-contact-save-btn"
                    :disabled="!editFirstName.trim() || savingContact"
                    @click="saveContactEdit"
                  >{{ savingContact ? "Saving..." : "Save" }}</button>
                  <button
                    class="tgc-contact-cancel-btn"
                    :disabled="savingContact"
                    @click="editingContact = false"
                  >Cancel</button>
                </div>
                <div v-if="saveContactError" class="error-msg">{{ saveContactError }}</div>
              </div>

              <div class="tgc-profile-rows">
                <div
                  v-if="profileDetails.username"
                  class="tgc-profile-row"
                  @click="copyField('@' + profileDetails.username)"
                >
                  <i class="fa-solid fa-at tgc-profile-row-icon"></i>
                  <div class="tgc-profile-row-body">
                    <div class="tgc-profile-row-label">Username</div>
                    <div class="tgc-profile-row-value">
                      @{{ profileDetails.username }}
                    </div>
                  </div>
                  <i class="fa-regular fa-copy tgc-copy-icon"></i>
                </div>

                <!-- A private group has no username to name it by, so the ID is what a job
                     has to go on -->
                <div
                  class="tgc-profile-row"
                  :title="t('tgc.copyPeerId')"
                  @click="copyField(profileDetails.peerId)"
                >
                  <i class="fa-solid fa-hashtag tgc-profile-row-icon"></i>
                  <div class="tgc-profile-row-body">
                    <div class="tgc-profile-row-label">{{ t('tgc.peerId') }}</div>
                    <div class="tgc-profile-row-value tgc-profile-row-mono">
                      {{ profileDetails.peerId }}
                    </div>
                  </div>
                  <i class="fa-regular fa-copy tgc-copy-icon"></i>
                </div>

                <div
                  v-if="profileDetails.phone"
                  class="tgc-profile-row"
                  @click="copyField(profileDetails.phone!)"
                >
                  <i class="fa-solid fa-phone tgc-profile-row-icon"></i>
                  <div class="tgc-profile-row-body">
                    <div class="tgc-profile-row-label">Phone</div>
                    <div class="tgc-profile-row-value">
                      {{ profileDetails.phone }}
                    </div>
                  </div>
                  <i class="fa-regular fa-copy tgc-copy-icon"></i>
                </div>

                <div
                  v-if="profileDetails.bio"
                  class="tgc-profile-row tgc-profile-row-nocopy"
                >
                  <i class="fa-solid fa-circle-info tgc-profile-row-icon"></i>
                  <div class="tgc-profile-row-body">
                    <div class="tgc-profile-row-label">Bio</div>
                    <div
                      class="tgc-profile-row-value tgc-bio-text"
                      v-html="linkifyBio(profileDetails.bio!)"
                      @click.capture="onMsgLinkClick"
                    ></div>
                  </div>
                </div>

                <div
                  v-if="profileDetails.memberCount"
                  class="tgc-profile-row tgc-profile-row-nocopy"
                >
                  <i class="fa-solid fa-users tgc-profile-row-icon"></i>
                  <div class="tgc-profile-row-body">
                    <div class="tgc-profile-row-label">{{ t('tgc.members') }}</div>
                    <div class="tgc-profile-row-value">
                      {{ profileDetails.memberCount.toLocaleString() }}
                    </div>
                  </div>
                </div>
              </div>

              <!-- Member list (groups only; channels rarely allow it) -->
              <div v-if="profileDetails.type === 'group'" class="tgc-members">
                <div class="tgc-members-head">
                  <span class="tgc-members-title">{{ t('tgc.members') }}</span>
                  <span v-if="membersTotal" class="tgc-members-count">
                    {{ filteredMembers.length }}/{{ membersTotal.toLocaleString() }}
                  </span>
                </div>

                <div class="tgc-members-search">
                  <i class="fa-solid fa-magnifying-glass tgc-search-icon"></i>
                  <input
                    v-model="memberSearch"
                    class="tgc-search-input"
                    :placeholder="t('tgc.searchMembers')"
                    @input="onMemberSearchInput"
                  />
                </div>

                <div v-if="membersError" class="error-msg">{{ membersError }}</div>

                <div class="tgc-member-list">
                  <div
                    v-for="m in filteredMembers"
                    :key="m.chatId"
                    class="tgc-member-item"
                    :title="t('tgc.openDm')"
                    @click="openMemberChat(m)"
                  >
                    <div
                      class="tgc-member-av"
                      :style="!avatarSrc(m.chatId) ? { background: senderColor(m.chatId) } : {}"
                      v-avatar-load="m.chatId"
                    >
                      <img
                        v-if="avatarSrc(m.chatId)"
                        :src="avatarSrc(m.chatId)"
                        class="tgc-sender-av-photo"
                        alt=""
                      />
                      <template v-else>{{ avatarLetter(m.name) }}</template>
                    </div>
                    <div class="tgc-member-body">
                      <div class="tgc-member-name">
                        {{ m.name }}
                        <span
                          v-if="m.status !== 'member'"
                          class="tgc-member-badge"
                        >{{ m.status === 'creator' ? t('tgc.owner') : t('tgc.admin') }}</span>
                      </div>
                      <div class="tgc-member-sub">
                        {{ m.username ? "@" + m.username : m.peerId }}
                      </div>
                    </div>
                  </div>

                  <div v-if="membersLoading" class="tgc-spinner-wrap">
                    <span class="tgc-spinner"></span>
                  </div>
                  <div
                    v-else-if="!filteredMembers.length && !membersError"
                    class="tgc-empty-list"
                  >
                    {{ t('tgc.noMembers') }}
                  </div>
                </div>

                <button
                  v-if="!memberSearch.trim() && members.length < membersTotal"
                  class="tgc-members-more"
                  :disabled="membersLoading"
                  @click="loadMembers()"
                >
                  {{ t('tgc.loadMoreMembers') }}
                </button>
              </div>

              <div class="tgc-profile-actions">
                <button
                  v-if="profileDetails.type === 'user' || profileDetails.type === 'bot'"
                  class="tgc-profile-action-btn tgc-profile-action-danger"
                  :disabled="blockToggling"
                  @click="toggleBlockFromProfile"
                >
                  <i class="fa-solid fa-ban"></i>
                  {{ profileDetails.blocked ? "Unblock user" : "Block user" }}
                </button>
                <button
                  class="tgc-profile-action-btn"
                  @click="openReportFromProfile"
                >
                  <i class="fa-solid fa-flag"></i> Report
                </button>
              </div>
            </div>
          </div>
          <!-- Thread panel -->
          <div v-if="showThread" class="tgc-thread-panel">
            <div class="tgc-profile-header">
              <span class="tgc-profile-title">
                Thread
                <span
                  v-if="threadRootMsg?.replyCount"
                  class="tgc-thread-count"
                  >{{ threadRootMsg.replyCount }}</span
                >
              </span>
              <button class="tgc-icon-btn" @click="showThread = false">
                <i class="fa-solid fa-xmark"></i>
              </button>
            </div>
            <!-- Root message preview -->
            <div v-if="threadRootMsg" class="tgc-thread-root">
              <div class="tgc-thread-root-text">
                {{ threadRootMsg.text || "(media)" }}
              </div>
            </div>
            <!-- Thread messages -->
            <div class="tgc-thread-messages" ref="threadEl">
              <div v-if="loadingThread" class="tgc-spinner-wrap">
                <span class="tgc-spinner"></span>
              </div>
              <template v-else>
                <div
                  v-for="msg in threadMessages"
                  :key="msg.id"
                  class="tgc-thread-msg"
                  :class="
                    msg.fromMe ? 'tgc-thread-msg-out' : 'tgc-thread-msg-in'
                  "
                >
                  <div class="tgc-thread-msg-name" v-if="!msg.fromMe">
                    {{ msg.fromName || "User" }}
                  </div>
                  <div
                    class="tgc-thread-msg-text"
                    v-html="msg.html ?? escMsgText(msg.text)"
                    @click="onMsgLinkClick($event)"
                  ></div>
                  <div class="tgc-thread-msg-time">
                    {{ fmtMsgTime(msg.date) }}
                  </div>
                </div>
                <div v-if="!threadMessages.length" class="tgc-empty-list">
                  No comments yet
                </div>
              </template>
            </div>
            <!-- Thread compose -->
            <div class="tgc-thread-compose">
              <textarea
                v-model="threadInputText"
                class="tgc-input"
                placeholder="Write a comment..."
                rows="1"
                @keydown.enter.exact="(e) => { if (!composing) { e.preventDefault(); sendThreadMessage(); } }"
                @compositionstart="composing = true"
                @compositionend="composing = false"
              ></textarea>
              <button
                class="tgc-send-btn"
                :disabled="!threadInputText.trim() || sendingThread"
                @click="sendThreadMessage"
              >
                <i class="fa-solid fa-paper-plane"></i>
              </button>
            </div>
          </div>
        </template>

        <!-- Empty state -->
        <div class="tgc-empty-state" v-else>
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="currentColor"
            width="56"
            height="56"
            style="opacity: 0.25"
          >
            <path
              d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.562 8.248-2.018 9.51c-.145.658-.537.818-1.084.508l-3-2.21-1.447 1.394c-.16.16-.295.295-.605.295l.213-3.053 5.56-5.023c.242-.213-.054-.333-.373-.12l-6.871 4.326-2.962-.924c-.643-.204-.657-.643.136-.953l11.57-4.461c.537-.194 1.006.131.881.71z"
            />
          </svg>
          <p>Select a conversation to start chatting</p>
        </div>
      </div>
      <!-- end tgc-body -->
    </div>
    <!-- end tgc-popup -->

    <!-- Mobile chat header actions menu -->
    <div
      v-if="chatMenuOpen"
      class="tgc-ctx-backdrop"
      @click="chatMenuOpen = false"
    ></div>
    <div
      v-if="chatMenuOpen"
      class="tgc-ctx-menu tgc-chat-menu"
      :style="{ top: chatMenuPos.top + 'px', right: chatMenuPos.right + 'px' }"
    >
      <button class="tgc-ctx-item" @click="chatMenuRun(toggleMsgSearch)">
        <i class="fa-solid fa-magnifying-glass"></i> {{ t('tgc.searchMessages') }}
      </button>
      <button class="tgc-ctx-item" @click="chatMenuRun(clearChatCache)">
        <i class="fa-solid fa-arrows-rotate"></i> {{ t('tgc.clearCache') }}
      </button>
      <button class="tgc-ctx-item" @click="chatMenuRun(() => (openMiniAppInApp = !openMiniAppInApp))">
        <i class="fa-solid fa-puzzle-piece"></i>
        {{ openMiniAppInApp ? t('tgc.miniAppInApp') : t('tgc.miniAppInBrowser') }}
      </button>
      <button class="tgc-ctx-item" @click="chatMenuRun(openGoUrlDialog)">
        <i class="fa-solid fa-globe"></i> {{ t('tgc.openUrl') }}
      </button>
      <div class="tgc-ctx-divider"></div>
      <button class="tgc-ctx-item" @click="chatMenuRun(closeChat)">
        <i class="fa-solid fa-xmark"></i> {{ t('tgc.closeChat') }}
      </button>
    </div>

    <!-- Context menu dismiss backdrop -->
    <div
      v-if="ctxMenu"
      class="tgc-ctx-backdrop"
      @click="closeCtx"
      @contextmenu.prevent="closeCtx"
    ></div>

    <!-- Dialog context menu (right-click / long-press) -->
    <div
      v-if="ctxMenu"
      class="tgc-ctx-menu"
      :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }"
    >
      <template v-if="ctxMenu?.dialog.muted">
        <button class="tgc-ctx-item" @click="ctxMute(0)">
          <i class="fa-solid fa-bell"></i> Unmute
        </button>
      </template>
      <template v-else>
        <button class="tgc-ctx-item" @click="ctxMute(8 * 3600)">
          <i class="fa-solid fa-bell-slash"></i> Mute 8 hours
        </button>
        <button class="tgc-ctx-item" @click="ctxMute(7 * 24 * 3600)">
          <i class="fa-solid fa-bell-slash"></i> Mute 1 week
        </button>
        <button class="tgc-ctx-item" @click="ctxMute(365 * 24 * 3600)">
          <i class="fa-solid fa-bell-slash"></i> Mute forever
        </button>
      </template>
      <div class="tgc-ctx-divider"></div>
      <button v-if="!ctxMenu?.dialog.pinned" class="tgc-ctx-item" @click="ctxPin(true)">
        <i class="fa-solid fa-thumbtack"></i> Pin
      </button>
      <button v-else class="tgc-ctx-item" @click="ctxPin(false)">
        <i class="fa-solid fa-thumbtack"></i> Unpin
      </button>
      <template v-if="tgFolders.length">
        <div class="tgc-ctx-divider"></div>
        <button class="tgc-ctx-item" @click.stop="ctxFolderExpanded = !ctxFolderExpanded">
          <i class="fa-solid fa-folder-plus"></i> Add to folder
          <i
            class="fa-solid fa-chevron-down tgc-ctx-chevron"
            :class="{ rotated: ctxFolderExpanded }"
          ></i>
        </button>
        <template v-if="ctxFolderExpanded">
          <button
            v-for="folder in tgFolders"
            :key="folder.id"
            class="tgc-ctx-item tgc-ctx-folder-item"
            @click="ctxAddToFolder(folder)"
          >
            <span class="tgc-ctx-folder-emoji">{{ folder.emoticon ?? "📁" }}</span>
            {{ folder.title }}
          </button>
        </template>
      </template>
      <div class="tgc-ctx-divider"></div>
      <button class="tgc-ctx-item" @click="ctxReport">
        <i class="fa-solid fa-flag"></i> Report
      </button>
      <template
        v-if="ctxMenu?.dialog.type === 'user' || ctxMenu?.dialog.type === 'bot'"
      >
        <button class="tgc-ctx-item tgc-ctx-danger" @click.stop="ctxBlock">
          <i class="fa-solid fa-ban"></i>
          {{ ctxConfirmBlock ? "Confirm block user" : "Block user" }}
        </button>
        <button class="tgc-ctx-item tgc-ctx-danger" @click="ctxDeleteChat">
          <i class="fa-solid fa-trash-can"></i> Delete chat
        </button>
      </template>
      <template
        v-if="ctxMenu?.dialog.type === 'group' || ctxMenu?.dialog.type === 'channel'"
      >
        <button class="tgc-ctx-item tgc-ctx-danger" @click.stop="ctxLeave">
          <i class="fa-solid fa-arrow-right-from-bracket"></i>
          <template v-if="ctxConfirmLeave">
            {{ ctxMenu?.dialog.type === "channel" ? "Confirm leave channel" : "Confirm leave group" }}
          </template>
          <template v-else>
            {{ ctxMenu?.dialog.type === "channel" ? "Leave channel" : "Leave group" }}
          </template>
        </button>
      </template>
    </div>

    <!-- Emoji reaction picker -->
    <div
      v-if="emojiPickerMsgId !== null"
      class="tgc-ctx-backdrop"
      @click="emojiPickerMsgId = null"
    ></div>
    <div
      v-if="emojiPickerMsgId !== null"
      class="tgc-emoji-picker"
      :style="{
        left: emojiPickerPos.x + 'px',
        top: emojiPickerPos.y + 'px',
        transform: 'translateY(-110%)',
      }"
    >
      <button
        v-for="e in QUICK_EMOJIS"
        :key="e"
        class="tgc-emoji-btn"
        @click="pickReaction(e)"
      >
        {{ e }}
      </button>
    </div>

    <!-- Copy toast -->
    <div v-if="copyToast" class="tgc-copy-toast">{{ copyToast }}</div>

    <!-- Contacts sub-panel -->
    <div
      v-if="showContacts"
      class="tgc-contacts-overlay"
      @click.self="showContacts = false"
    >
      <div class="tgc-contacts-panel">
        <div class="tgc-contacts-header">
          <span>Contacts</span>
          <button class="tgc-icon-btn" @click="showContacts = false">
            <i class="fa-solid fa-xmark"></i>
          </button>
        </div>

        <div class="tgc-contacts-search">
          <i class="fa-solid fa-magnifying-glass tgc-search-icon"></i>
          <input
            v-model="contactSearch"
            class="tgc-search-input"
            placeholder="Search contacts..."
          />
        </div>

        <div class="tgc-contact-list">
          <div v-if="loadingContacts" class="tgc-spinner-wrap">
            <span class="tgc-spinner"></span>
          </div>
          <template v-else>
            <div
              v-for="c in filteredContacts"
              :key="c.chatId"
              class="tgc-contact-item"
              @click="openContactChat(c)"
            >
              <div class="tgc-avatar tgc-avatar-user tgc-avatar-sm">
                {{ avatarLetter(c.firstName || c.username || "?") }}
              </div>
              <div class="tgc-contact-info">
                <div class="tgc-contact-name">
                  {{ c.firstName }} {{ c.lastName }}
                </div>
                <div class="tgc-contact-sub">
                  {{ c.username ? "@" + c.username : (c.phone ?? "") }}
                </div>
              </div>
            </div>
            <div v-if="!filteredContacts.length" class="tgc-empty-list">
              No contacts
            </div>
          </template>
        </div>

        <!-- Add contact form -->
        <div class="tgc-add-contact">
          <div class="tgc-add-contact-title">Add Contact</div>
          <div class="tgc-add-contact-fields">
            <input
              v-model="newPhone"
              class="form-input"
              placeholder="+1234567890"
            />
            <input
              v-model="newFirstName"
              class="form-input"
              placeholder="First name"
            />
            <button
              class="btn btn-primary"
              :disabled="
                !newPhone.trim() || !newFirstName.trim() || addingContact
              "
              @click="addContactSubmit"
            >
              {{ addingContact ? "..." : "Add" }}
            </button>
          </div>
          <div v-if="addContactError" class="error-msg" style="margin-top: 6px">
            {{ addContactError }}
          </div>
          <div v-if="addContactOk" class="success-msg" style="margin-top: 6px">
            Contact added!
          </div>
        </div>
      </div>
    </div>
  </div>
  <!-- Invite link join confirmation -->
  <div
    v-if="invitePreview || checkingInvite"
    class="tgc-invite-overlay"
    @click.self="invitePreview = null"
  >
    <div class="tgc-invite-card">
      <template v-if="checkingInvite">
        <span
          class="tgc-spinner"
          style="margin: 24px auto; display: block; width: 28px; height: 28px"
        ></span>
      </template>
      <template v-else-if="invitePreview">
        <div class="tgc-invite-icon">
          <i
            :class="
              invitePreview.type === 'channel'
                ? 'fa-solid fa-bullhorn'
                : 'fa-solid fa-users'
            "
          ></i>
        </div>
        <div class="tgc-invite-title">{{ invitePreview.title }}</div>
        <div class="tgc-invite-meta">
          {{ invitePreview.memberCount.toLocaleString() }}
          {{ invitePreview.type === "channel" ? "subscribers" : "members" }}
        </div>
        <div class="tgc-invite-actions">
          <button class="tgc-invite-cancel" @click="invitePreview = null">
            Cancel
          </button>
          <button
            class="tgc-invite-join"
            :disabled="joiningInvite"
            @click="confirmJoinInvite"
          >
            <span v-if="joiningInvite"
              ><span class="tgc-spinner tgc-spinner-sm"></span> Joining...</span
            >
            <span v-else
              >Join
              {{ invitePreview.type === "channel" ? "Channel" : "Group" }}</span
            >
          </button>
        </div>
      </template>
    </div>
  </div>
  <!-- Go to URL dialog -->
  <div
    v-if="showGoUrlDialog"
    class="tgc-invite-overlay"
    @click.self="showGoUrlDialog = false"
  >
    <div class="tgc-invite-card tgc-gourl-card">
      <div class="tgc-invite-icon">
        <i class="fa-solid fa-globe"></i>
      </div>
      <div class="tgc-invite-title">Open URL</div>
      <div class="tgc-gourl-hint">Paste a Telegram link or any URL</div>
      <input
        ref="goUrlInputEl"
        v-model="goUrlInput"
        class="tgc-gourl-input"
        type="url"
        placeholder="https://t.me/..."
        @keydown.enter="submitGoUrl"
        @keydown.esc="showGoUrlDialog = false"
      />
      <div class="tgc-invite-actions">
        <button class="tgc-invite-cancel" @click="showGoUrlDialog = false">Cancel</button>
        <button
          class="tgc-invite-join"
          :disabled="!goUrlInput.trim()"
          @click="submitGoUrl"
        >
          Go
        </button>
      </div>
    </div>
  </div>
  <!-- Report dialog -->
  <div
    v-if="reportTarget"
    class="tgc-invite-overlay"
    @click.self="reportTarget = null"
  >
    <div class="tgc-invite-card tgc-report-card">
      <div class="tgc-invite-icon"><i class="fa-solid fa-flag"></i></div>
      <div class="tgc-invite-title">Report {{ reportTarget.name }}</div>
      <div
        v-if="reportTarget.type === 'user' || reportTarget.type === 'bot'"
        class="tgc-invite-meta"
      >
        {{ reportTarget.name }} will also be blocked and the chat deleted.
      </div>
      <div class="tgc-report-reasons">
        <label
          v-for="r in REPORT_REASONS"
          :key="r.value"
          class="tgc-report-reason"
        >
          <input type="radio" :value="r.value" v-model="reportReason" />
          {{ r.label }}
        </label>
      </div>
      <textarea
        v-model="reportComment"
        class="tgc-gourl-input tgc-report-comment"
        rows="2"
        placeholder="Add a comment (optional)"
      ></textarea>
      <div class="tgc-invite-actions">
        <button class="tgc-invite-cancel" @click="reportTarget = null">
          Cancel
        </button>
        <button
          class="tgc-invite-join tgc-danger-btn"
          :disabled="reportSending"
          @click="submitReport"
        >
          {{ reportSending ? "Reporting..." : "Report" }}
        </button>
      </div>
    </div>
  </div>

  <!-- Delete message confirmation -->
  <div
    v-if="deleteMsgIds"
    class="tgc-invite-overlay"
    @click.self="deleteMsgIds = null"
  >
    <div class="tgc-invite-card">
      <div class="tgc-invite-icon"><i class="fa-solid fa-trash-can"></i></div>
      <div class="tgc-invite-title">
        {{ deleteMsgIds.length > 1 ? `Delete ${deleteMsgIds.length} messages` : "Delete message" }}
      </div>
      <div class="tgc-invite-meta">
        {{ deleteMsgIds.length > 1
          ? "Are you sure you want to delete these messages?"
          : "Are you sure you want to delete this message?" }}
      </div>
      <label
        v-if="activeChat && activeChat.type !== 'channel'"
        class="tgc-revoke-check"
      >
        <input type="checkbox" v-model="deleteMsgRevoke" />
        Also delete for {{ activeChat.type === "group" ? "everyone" : activeChat.name }}
      </label>
      <div class="tgc-invite-actions">
        <button class="tgc-invite-cancel" @click="deleteMsgIds = null">
          Cancel
        </button>
        <button
          class="tgc-invite-join tgc-danger-btn"
          :disabled="deletingMsg"
          @click="confirmDeleteMsg"
        >
          {{ deletingMsg ? "Deleting..." : "Delete" }}
        </button>
      </div>
    </div>
  </div>

  <!-- Share phone number confirmation -->
  <div
    v-if="sharePhoneTarget"
    class="tgc-invite-overlay"
    @click.self="sharePhoneTarget = null"
  >
    <div class="tgc-invite-card">
      <div class="tgc-invite-icon"><i class="fa-solid fa-phone"></i></div>
      <div class="tgc-invite-title">{{ t("tgc.sharePhone.title") }}</div>
      <div class="tgc-invite-meta">
        {{ sharePhoneTarget.chatName }} -- {{ t("tgc.sharePhone.body") }}
      </div>
      <label class="tgc-revoke-check">
        <input type="checkbox" v-model="sharePhoneUseCustom" />
        {{ t("tgc.sharePhone.useCustom") }}
      </label>
      <template v-if="sharePhoneUseCustom">
        <input
          v-model="sharePhoneCustom"
          class="tgc-phone-input"
          type="tel"
          :placeholder="t('tgc.sharePhone.placeholder')"
        />
        <div
          v-if="sharePhoneHint"
          class="tgc-phone-check"
          :class="`tgc-phone-check-${sharePhoneHint.tone}`"
        >
          <i
            class="fa-solid"
            :class="
              sharePhoneHint.tone === 'good'
                ? 'fa-circle-check'
                : sharePhoneHint.tone === 'bad'
                  ? 'fa-circle-exclamation'
                  : 'fa-circle-info'
            "
          ></i>
          {{ sharePhoneHint.text }}
        </div>
        <!-- The check is a help, not a ruling: a numbering plan we have wrong must not stop
             a number that is in fact right -->
        <label
          v-if="sharePhoneHint?.tone === 'bad' && sharePhoneCheck.status !== 'malformed'"
          class="tgc-revoke-check"
        >
          <input type="checkbox" v-model="sharePhoneIgnoreCheck" />
          {{ t("tgc.sharePhone.ignoreCheck") }}
        </label>
        <div class="tgc-phone-warning">
          <i class="fa-solid fa-triangle-exclamation"></i>
          {{ t("tgc.sharePhone.customWarning") }}
        </div>
      </template>
      <div class="tgc-invite-actions">
        <button class="tgc-invite-cancel" @click="sharePhoneTarget = null">
          {{ t("common.cancel") }}
        </button>
        <button
          class="tgc-invite-join"
          :disabled="sharingPhone || !sharePhoneReady"
          @click="confirmSharePhone"
        >
          {{ sharingPhone ? t("tgc.sharePhone.sending") : t("tgc.sharePhone.confirm") }}
        </button>
      </div>
    </div>
  </div>

  <!-- Delete chat confirmation -->
  <div
    v-if="deleteChatTarget"
    class="tgc-invite-overlay"
    @click.self="deleteChatTarget = null"
  >
    <div class="tgc-invite-card">
      <div class="tgc-invite-icon"><i class="fa-solid fa-trash-can"></i></div>
      <div class="tgc-invite-title">Delete chat</div>
      <div class="tgc-invite-meta">
        Permanently delete the chat with {{ deleteChatTarget.name }}?
      </div>
      <label class="tgc-revoke-check">
        <input type="checkbox" v-model="deleteChatRevoke" />
        Also delete for {{ deleteChatTarget.name }}
      </label>
      <div class="tgc-invite-actions">
        <button class="tgc-invite-cancel" @click="deleteChatTarget = null">
          Cancel
        </button>
        <button
          class="tgc-invite-join tgc-danger-btn"
          :disabled="deletingChat"
          @click="confirmDeleteChat"
        >
          {{ deletingChat ? "Deleting..." : "Delete chat" }}
        </button>
      </div>
    </div>
  </div>

  <!-- Open link chooser -->
  <div
    v-if="linkChooserUrl"
    class="tgc-invite-overlay"
    @click.self="linkChooserUrl = null"
  >
    <div class="tgc-invite-card tgc-openlink-card">
      <div class="tgc-invite-icon"><i class="fa-solid fa-globe"></i></div>
      <div class="tgc-invite-title">{{ t("tgc.openLink.title") }}</div>
      <div class="tgc-openlink-url">{{ linkChooserUrl }}</div>
      <div class="tgc-invite-actions">
        <button
          class="tgc-invite-join"
          :disabled="linkOpening"
          @click="openLinkInBemby"
        >
          <span v-if="linkOpening">
            <span class="tgc-spinner tgc-spinner-sm"></span>
            {{ t("tgc.openLink.checking") }}
          </span>
          <span v-else>
            <i class="fa-solid fa-window-maximize"></i>
            {{ t("tgc.openLink.inBemby") }}
          </span>
        </button>
        <button
          class="tgc-invite-join"
          :disabled="linkOpening"
          @click="openLinkInBrowser"
        >
          <i class="fa-solid fa-arrow-up-right-from-square"></i>
          {{ t("tgc.openLink.inBrowser") }}
        </button>
      </div>
      <button
        class="tgc-invite-cancel tgc-openlink-cancel"
        :disabled="linkOpening"
        @click="linkChooserUrl = null"
      >
        {{ t("common.cancel") }}
      </button>
    </div>
  </div>

  <!-- Clean account confirmation -->
  <div
    v-if="showCleanConfirm"
    class="tgc-invite-overlay"
    @click.self="closeCleanConfirm"
  >
    <div class="tgc-invite-card tgc-clean-card">
      <div class="tgc-invite-icon tgc-clean-icon">
        <i class="fa-solid fa-triangle-exclamation"></i>
      </div>
      <div class="tgc-invite-title">{{ t("tgc.clean.title") }}</div>
      <div class="tgc-clean-account-line">
        {{ t("tgc.clean.bembyAccount") }}
        <strong>{{ selectedAccount?.name }}</strong>
      </div>
      <div class="tgc-clean-account-line">
        {{ t("tgc.clean.tgAccount") }}
        <strong>{{
          selectedAccount?.tgDisplayName ||
          selectedAccount?.tgUsername ||
          selectedAccount?.phoneNumber ||
          t("tgc.clean.unknown")
        }}</strong>
      </div>
      <div class="tgc-invite-meta tgc-clean-warning">
        {{ t("tgc.clean.actionsIntro") }}
        <ul class="tgc-clean-list">
          <li>{{ t("tgc.clean.actionLeaveGroups") }}</li>
          <li>{{ t("tgc.clean.actionLeaveChannels") }}</li>
          <li>{{ t("tgc.clean.actionDeleteChats") }}</li>
          <li>{{ t("tgc.clean.actionRemoveContacts") }}</li>
          <li>{{ t("tgc.clean.actionRemoveFolders") }}</li>
        </ul>
        {{ t("tgc.clean.keptNote") }}
      </div>
      <label class="tgc-revoke-check">
        <input type="checkbox" v-model="cleanConfirmChecked" />
        {{ t("tgc.clean.confirmCheck") }}
      </label>
      <div class="tgc-invite-actions">
        <button
          class="tgc-invite-cancel"
          :disabled="cleaning"
          @click="closeCleanConfirm"
        >
          {{ t("common.cancel") }}
        </button>
        <button
          class="tgc-invite-join tgc-danger-btn"
          :disabled="!cleanConfirmChecked || cleaning"
          @click="confirmCleanAccount"
        >
          <span v-if="cleaning">
            <span class="tgc-spinner tgc-spinner-sm"></span>
            {{ t("tgc.clean.cleaning") }}
          </span>
          <span v-else>{{ t("tgc.clean.confirmBtn") }}</span>
        </button>
      </div>
    </div>
  </div>

  <!-- Forward message picker -->
  <div
    v-if="forwardIds"
    class="tgc-invite-overlay"
    @click.self="closeForward"
  >
    <div class="tgc-invite-card tgc-forward-card">
      <div class="tgc-invite-title">
        {{ forwardIds.length > 1 ? `Forward ${forwardIds.length} messages` : "Forward message" }}
      </div>
      <input
        v-model="forwardFilter"
        class="tgc-gourl-input"
        type="text"
        placeholder="Search chats..."
        @keydown.esc="closeForward"
      />
      <div class="tgc-forward-list">
        <button
          v-for="d in forwardTargets"
          :key="d.chatId"
          class="tgc-forward-item"
          :disabled="forwardSending"
          @click="doForward(d)"
        >
          <div
            class="tgc-avatar tgc-forward-avatar"
            :class="`tgc-avatar-${d.type}`"
            v-avatar-load="d.chatId"
          >
            <img
              v-if="avatarSrc(d.chatId)"
              :src="avatarSrc(d.chatId)"
              class="tgc-avatar-photo"
              alt=""
            />
            <template v-else>{{ avatarLetter(d.name) }}</template>
          </div>
          <span class="tgc-forward-name">{{ d.name }}</span>
        </button>
        <div v-if="!forwardTargets.length" class="tgc-empty-list">
          No chats found
        </div>
      </div>
      <div class="tgc-invite-actions">
        <button class="tgc-invite-cancel" @click="closeForward">Cancel</button>
      </div>
    </div>
  </div>

  <!-- Image lightbox -->
  <div v-if="lightboxUrl" class="tgc-lightbox" @click="lightboxUrl = null">
    <button class="tgc-lightbox-close" title="Close" @click.stop="lightboxUrl = null">
      <i class="fa-solid fa-xmark"></i>
    </button>
    <img :src="lightboxUrl" class="tgc-lightbox-img" @click.stop />
  </div>
  <!-- end tgc-page -->
</template>

<script setup lang="ts">
import {
  ref,
  computed,
  watch,
  onMounted,
  onBeforeUnmount,
  nextTick,
} from "vue";
import {
  accountsApi,
  tgClientApi,
  type Account,
  type TgDialog,
  type TgMessage,
  type TgBotCommand,
  type TgBotMenuButton,
  type TgContact,
  type TgFolder,
  type TgProfile,
  type TgMember,
  type TgInvitePreview,
  type TgReportReason,
} from "../api/client";
import { avatarCache, avatarQueue, avatarQueued, avatarFetching, avatarConcurrencyState, persistAvatarCache } from "../composables/avatarCache";
import { t } from "../i18n";
import { copyText } from "../utils/clipboard";
import {
  formatAccountLabel,
  loadAccountDisplaySetting,
} from "../composables/accountDisplay";
import { displayPeerId } from "../utils/peerId";
import { fuzzyScore } from "../utils/fuzzy";
import { debounce } from "../composables/useDebounce";
import { takeMessengerAccountId } from "../composables/viewNav";
import { checkPhoneNumber, expectedDigitsText } from "../utils/phoneCountry";

// ── Messenger state persistence ───────────────────────────────────────────────

const MESSENGER_STATE_KEY = "bemby_messenger_state";
type MessengerState = { accountId: number; dialog: TgDialog | null };

function loadMessengerState(): MessengerState | null {
  try {
    const raw = localStorage.getItem(MESSENGER_STATE_KEY);
    return raw ? (JSON.parse(raw) as MessengerState) : null;
  } catch {
    return null;
  }
}

function saveMessengerState(): void {
  if (!selectedAccountId.value) {
    localStorage.removeItem(MESSENGER_STATE_KEY);
    return;
  }
  try {
    const state: MessengerState = {
      accountId: selectedAccountId.value,
      dialog: activeChat.value ?? null,
    };
    localStorage.setItem(MESSENGER_STATE_KEY, JSON.stringify(state));
  } catch {}
}

// ── State ─────────────────────────────────────────────────────────────────────

const accounts = ref<Account[]>([]);
const authenticatedAccounts = computed(() =>
  accounts.value.filter((a) => a.authStatus === "authenticated" && !a.disabled),
);

const selectedAccountId = ref<number | null>(null);
const dialogs = ref<TgDialog[]>([]);
const loadingDialogs = ref(false);
const dialogError = ref("");
const reconnecting = ref(false);

const AVATAR_CONCURRENCY = 3;

const searchQuery = ref("");
const searchResults = ref<TgDialog[] | null>(null);
const searchTimer = ref<ReturnType<typeof setTimeout> | null>(null);
const searchLoading = ref(false);
const searchError = ref<string | null>(null);

const activeChatId = ref<string | null>(null);
const activeChat = ref<TgDialog | null>(null);
const messages = ref<TgMessage[]>([]);
const pinnedMsg = ref<TgMessage | null>(null);
// In-chat message search
const msgSearchOpen = ref(false);
const msgSearchQuery = ref('');
const msgSearchResults = ref<TgMessage[]>([]);
const msgSearchLoading = ref(false);
const msgSearchDone = ref(false);
const msgSearchInputEl = ref<HTMLInputElement | null>(null);
// Mobile chat header actions menu (collapsed buttons)
const chatMenuOpen = ref(false);
const chatMenuPos = ref({ top: 0, right: 0 });

function toggleChatMenu(ev: MouseEvent) {
  if (chatMenuOpen.value) {
    chatMenuOpen.value = false;
    return;
  }
  const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
  chatMenuPos.value = {
    top: rect.bottom + 4,
    right: window.innerWidth - rect.right,
  };
  chatMenuOpen.value = true;
}

function chatMenuRun(action: () => void) {
  chatMenuOpen.value = false;
  action();
}
const firstUnreadId = ref<number | null>(null);
const loadingMessages = ref(false);
const loadingOlder = ref(false);
const canLoadMore = ref(true);
const sending = ref(false);
const inputText = ref("");

const joiningChannel = ref(false);
const joinRequestSent = ref(false);
// chatId of the group/channel whose join request is pending -- survives chat navigation
const pendingJoinChatId = ref<string | null>(null);
let membershipPollTimer: ReturnType<typeof setInterval> | null = null;

// Debounced mark-read -- coalesces rapid calls (e.g. burst of incoming messages) into one request
let markReadTimer: ReturnType<typeof setTimeout> | null = null;
let markReadPending: { chatId: string; maxId: number } | null = null;

// Watcher that keeps re-fetching the last bot message while the bot is still editing it
let botMsgWatchTimer: ReturnType<typeof setTimeout> | null = null;
let botMsgWatchGen = 0;
let botMsgWatchText = '';
let botMsgWatchStaleTicks = 0;
let botMsgWatchTotalTicks = 0;

const showContacts = ref(false);
const contacts = ref<TgContact[]>([]);
const loadingContacts = ref(false);
const contactSearch = ref("");
const newPhone = ref("");
const newFirstName = ref("");
const addingContact = ref(false);
const editingContact = ref(false);
const editFirstName = ref("");
const editLastName = ref("");
const savingContact = ref(false);
const saveContactError = ref("");
const addContactError = ref("");
const addContactOk = ref(false);

const messagesEl = ref<HTMLElement | null>(null);
const inputEl = ref<HTMLTextAreaElement | null>(null);
const composing = ref(false);

// Attachment composer state
const fileInput = ref<HTMLInputElement | null>(null);
const pendingFile = ref<File | null>(null);
const pendingPreviewUrl = ref<string | null>(null);
const sendAsDocument = ref(false);

// Image lightbox
const lightboxUrl = ref<string | null>(null);
const showMobileChat = ref(false);
const showProfile = ref(false);
const webViewPanel = ref<{
  url: string;
  title: string;
  proxied?: boolean;
  /** Served from the viewer origin, so a real origin of its own is safe to grant. */
  isolated?: boolean;
} | null>(null);
// Chooser for non-Telegram links: Bemby viewer or external browser
const linkChooserUrl = ref<string | null>(null);
const linkOpening = ref(false);
const openMiniAppInApp = ref(true);
const profileDetails = ref<TgProfile | null>(null);
const profileLoading = ref(false);
// Group members shown in the info panel, plus the fuzzy filter over them
const MEMBER_PAGE = 200;
const members = ref<TgMember[]>([]);
const membersTotal = ref(0);
const membersLoading = ref(false);
const membersError = ref("");
const memberSearch = ref("");
/** Server-side hits for the current query -- members past the loaded pages. */
const memberSearchHits = ref<TgMember[]>([]);
const copyToast = ref("");
const btnLoadingKey = ref<string | null>(null);

// Pending "share my phone number" confirmation
type SharePhoneTarget = { msgId: number; key: string; chatName: string };
const sharePhoneTarget = ref<SharePhoneTarget | null>(null);
const sharingPhone = ref(false);
const sharePhoneUseCustom = ref(false);
const sharePhoneCustom = ref("");
/** Ticked to send a number whose length does not match its country anyway. */
const sharePhoneIgnoreCheck = ref(false);

// Telegram stores numbers as digits; a leading + and separators are cosmetic. The country code
// says how many digits the number should carry, which is the mistake worth catching here: the
// number goes to whoever asked for it and cannot be taken back.
const sharePhoneCheck = computed(() => checkPhoneNumber(sharePhoneCustom.value));

const sharePhoneReady = computed(() => {
  if (!sharePhoneUseCustom.value) return true;
  const check = sharePhoneCheck.value;
  if (check.status === "empty" || check.status === "malformed") return false;
  return check.ok || sharePhoneIgnoreCheck.value;
});

/** The line under the field: what country the code points at, and whether the length fits. */
const sharePhoneHint = computed(() => {
  const check = sharePhoneCheck.value;
  const where = check.country ? `${check.country.flag} ${check.country.name}` : "";
  switch (check.status) {
    case "empty":
      return null;
    case "malformed":
      return { tone: "bad" as const, text: t("tgc.sharePhone.lenMalformed") };
    case "unverified":
      return {
        tone: "plain" as const,
        text: t("tgc.sharePhone.lenUnverified").replace("{country}", where),
      };
    case "ok":
      return {
        tone: "good" as const,
        text: t("tgc.sharePhone.lenOk")
          .replace("{country}", where)
          .replace("{n}", String(check.digits.length)),
      };
    default:
      return {
        tone: "bad" as const,
        text: t(
          check.status === "tooShort"
            ? "tgc.sharePhone.lenTooShort"
            : "tgc.sharePhone.lenTooLong",
        )
          .replace("{country}", where)
          .replace("{expected}", expectedDigitsText(check.expected!))
          .replace("{n}", String(check.digits.length)),
      };
  }
});

// Reply compose
const replyingTo = ref<TgMessage | null>(null);

// Emoji reaction picker
const emojiPickerMsgId = ref<number | null>(null);
const activeMsgId = ref<number | null>(null);
const emojiPickerPos = ref({ x: 0, y: 0 });
const QUICK_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "👎", "🔥", "🎉"];

// Bot commands
const botCommands = ref<TgBotCommand[]>([]);
// The Mini App this bot pins beside the composer, if it has one
const botMenuButton = ref<TgBotMenuButton | null>(null);
const selectedCmdIdx = ref(-1);

// Invite link preview / join confirmation
const invitePreview = ref<TgInvitePreview | null>(null);
const checkingInvite = ref(false);
const joiningInvite = ref(false);

// Go-to-URL dialog
const showGoUrlDialog = ref(false);
const goUrlInput = ref("");
const goUrlInputEl = ref<HTMLInputElement | null>(null);

// Chat navigation history -- used so "back" returns to the previous chat
// when the user was navigated here from within another chat (e.g. via invite link or URL button)
const chatNavStack = ref<TgDialog[]>([]);

// Thread / comments panel
const showThread = ref(false);
const threadRootMsg = ref<TgMessage | null>(null);
const threadMessages = ref<TgMessage[]>([]);
const loadingThread = ref(false);
const threadInputText = ref("");
const sendingThread = ref(false);
const threadEl = ref<HTMLElement | null>(null);

// Context menu for dialog actions
const ctxMenu = ref<{ dialog: TgDialog; x: number; y: number } | null>(null);
const ctxFolderExpanded = ref(false);
const ctxConfirmLeave = ref(false);
const ctxConfirmBlock = ref(false);

// Block / report / delete chat
const blockToggling = ref(false);
const reportTarget = ref<{
  chatId: string;
  name: string;
  type: TgDialog["type"];
} | null>(null);
const reportReason = ref<TgReportReason>("spam");
const reportComment = ref("");
const reportSending = ref(false);
const deleteChatTarget = ref<TgDialog | null>(null);
const deleteChatRevoke = ref(true);
const deletingChat = ref(false);

// Clean account (bulk leave/delete)
const showCleanConfirm = ref(false);
const cleanConfirmChecked = ref(false);
const cleaning = ref(false);
const clearingCache = ref(false);
const selectedAccount = computed(
  () =>
    authenticatedAccounts.value.find(
      (a) => a.id === selectedAccountId.value,
    ) ?? null,
);

const REPORT_REASONS: { value: TgReportReason; label: string }[] = [
  { value: "spam", label: "Spam" },
  { value: "violence", label: "Violence" },
  { value: "pornography", label: "Pornography" },
  { value: "childAbuse", label: "Child abuse" },
  { value: "illegalDrugs", label: "Illegal drugs" },
  { value: "personalDetails", label: "Personal details" },
  { value: "fake", label: "Fake account" },
  { value: "copyright", label: "Copyright" },
  { value: "other", label: "Other" },
];

// Message edit / delete / forward
const editingMsg = ref<TgMessage | null>(null);
const deleteMsgIds = ref<number[] | null>(null);
const deleteMsgRevoke = ref(true);
const deletingMsg = ref(false);
const forwardIds = ref<number[] | null>(null);
const forwardFilter = ref("");
const forwardSending = ref(false);

// Multi-select mode
const selectMode = ref(false);
const selectedMsgIds = ref<Set<number>>(new Set());

// Typing indicators: chatId -> name of who is typing (null in private chats)
const typingChats = ref<Record<string, string | null>>({});
const typingTimers = new Map<string, ReturnType<typeof setTimeout>>();
let lastTypingSent = 0;

const forwardTargets = computed(() => {
  const q = forwardFilter.value.trim().toLowerCase();
  return dialogs.value.filter((d) => {
    if (d.left) return false;
    if (!q) return true;
    return (
      d.name.toLowerCase().includes(q) ||
      (d.username ?? "").toLowerCase().includes(q)
    );
  });
});
// ── Priority request management ───────────────────────────────────────────────
// bgDialogCtrl: the in-flight background 200-dialog fetch -- aborted when the
// user initiates any action so their request gets the connection immediately.
let bgDialogCtrl: AbortController | null = null;
// msgFetchCtrl: the in-flight messages fetch -- aborted if the user switches
// chats before the previous fetch completes.
let msgFetchCtrl: AbortController | null = null;

function cancelBgDialogLoad() {
  bgDialogCtrl?.abort();
  bgDialogCtrl = null;
}

// Kick off (or re-kick) the full 200-dialog background load.
function startBgDialogLoad(accountId: number) {
  cancelBgDialogLoad();
  bgDialogCtrl = new AbortController();
  const ctrl = bgDialogCtrl;
  tgClientApi
    .dialogs(accountId, { limit: 200 }, ctrl.signal)
    .then((allDialogs) => {
      bgDialogCtrl = null;
      if (selectedAccountId.value !== accountId) return;
      const localZeroed = new Set(
        dialogs.value.filter((d) => d.unreadCount === 0).map((d) => d.chatId),
      );
      dialogs.value = allDialogs.map((d) =>
        localZeroed.has(d.chatId) ? { ...d, unreadCount: 0 } : d,
      );
    })
    .catch(() => {
      if (ctrl.signal.aborted) return; // expected cancellation -- not an error
    });
}

let longPressTimer: ReturnType<typeof setTimeout> | null = null;
const tgFolders = ref<TgFolder[]>([]);
const activeFolder = ref<"all" | number>("all");

let liveWs: WebSocket | null = null;
let wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let wsBackoff = 1_000; // ms, doubles on each failure, caps at 30s
let wsAccountId: number | null = null; // account the socket is open for
let wsEverOpen = false; // distinguishes first-open from reconnect
let scrolledToBottom = true;

// Floating jump-to-latest button (shown when scrolled away from the bottom)
const jumpBtnVisible = ref(false);
const jumpUnseenCount = ref(0);

function jumpToLatest() {
  jumpUnseenCount.value = 0;
  scrollBottom(true);
}

// ── Computed ──────────────────────────────────────────────────────────────────

const displayedDialogs = computed(() => {
  const base = searchResults.value ?? dialogs.value;
  if (activeFolder.value === "all") return base;

  const folder = tgFolders.value.find((f) => f.id === activeFolder.value);
  if (!folder) return base;

  return base.filter((d) => {
    if (folder.excludedChatIds.includes(d.chatId)) return false;
    if (folder.pinnedChatIds.includes(d.chatId)) return true;
    if (folder.includedChatIds.includes(d.chatId)) return true;
    if (folder.includeBots && d.type === "bot") return true;
    if (
      (folder.includeContacts || folder.includeNonContacts) &&
      d.type === "user"
    )
      return true;
    if (folder.includeGroups && d.type === "group") return true;
    if (folder.includeBroadcasts && d.type === "channel") return true;
    return false;
  });
});

const filteredContacts = computed(() => {
  const q = contactSearch.value.toLowerCase();
  if (!q) return contacts.value;
  return contacts.value.filter((c) =>
    [c.firstName, c.lastName, c.username, c.phone].some((v) =>
      v?.toLowerCase().includes(q),
    ),
  );
});

// Command suggestions: shown while input starts with "/" and no space yet
const commandSuggestions = computed(() => {
  if (!botCommands.value.length) return [];
  const text = inputText.value;
  if (!text.startsWith("/")) return [];
  // Once a space is typed the command word is done -- hide suggestions
  if (text.includes(" ")) return [];
  const query = text.slice(1).toLowerCase();
  if (!query) return botCommands.value;
  return botCommands.value.filter((c) =>
    c.command.toLowerCase().startsWith(query),
  );
});

// ── Lifecycle ─────────────────────────────────────────────────────────────────

onMounted(async () => {
  window.addEventListener("message", handleMiniAppMessage);
  loadAccountDisplaySetting();
  // Inline photos are loaded by <img src>, which cannot send a header, so they go through a
  // short-lived media ticket instead. Fetched before the first message renders.
  await tgClientApi.ensureMediaTicket().catch(() => {});
  accounts.value = await accountsApi.list().catch(() => []);
  if (!authenticatedAccounts.value.length) return;

  // An account the Accounts view sent us to wins over the one this view had last, and its
  // chat is not restored: the point of arriving that way is the account, not where it was
  const asked = takeMessengerAccountId();
  const askedValid =
    asked != null && authenticatedAccounts.value.some((a) => a.id === asked);

  const saved = loadMessengerState();
  const savedAccountValid =
    !askedValid &&
    saved != null &&
    authenticatedAccounts.value.some((a) => a.id === saved.accountId);
  selectedAccountId.value = askedValid
    ? asked!
    : savedAccountValid
      ? saved!.accountId
      : authenticatedAccounts.value[0].id;

  await loadDialogs();
  startLiveSocket();

  // Restore the last open chat -- messages load from cache instantly, new ones sync via WS
  if (savedAccountValid && saved!.dialog) {
    openChat(saved!.dialog);
  }
});

onBeforeUnmount(() => {
  closeLiveSocket();
  stopMembershipPoll();
  window.removeEventListener("message", handleMiniAppMessage);
  if (searchTimer.value) clearTimeout(searchTimer.value);
  _avatarObserver?.disconnect();
  _avatarObserver = null;
});

watch(showContacts, async (val) => {
  if (val && !contacts.value.length) await loadContacts();
});

watch(commandSuggestions, () => {
  selectedCmdIdx.value = -1;
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function onDialogContextMenu(e: MouseEvent, dialog: TgDialog) {
  e.preventDefault();
  ctxMenu.value = { dialog, x: e.clientX, y: e.clientY };
}

function onDialogTouchStart(e: TouchEvent, dialog: TgDialog) {
  longPressTimer = setTimeout(() => {
    const t = e.touches[0];
    ctxMenu.value = { dialog, x: t.clientX, y: t.clientY };
  }, 500);
}

function onDialogTouchEnd() {
  if (longPressTimer) {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }
}

function closeCtx() {
  ctxMenu.value = null;
  ctxFolderExpanded.value = false;
  ctxConfirmLeave.value = false;
  ctxConfirmBlock.value = false;
}

async function ctxMute(secs: number) {
  if (!ctxMenu.value || !selectedAccountId.value) return;
  const { dialog } = ctxMenu.value;
  closeCtx();
  try {
    await tgClientApi.mute(selectedAccountId.value, dialog.chatId, secs);
    // Update local state so the menu reflects the new mute state immediately
    const local = dialogs.value.find((d) => d.chatId === dialog.chatId);
    if (local) local.muted = secs > 0;
    copyToast.value = secs === 0 ? "Unmuted" : "Muted";
    if (copyToastTimer) clearTimeout(copyToastTimer);
    copyToastTimer = setTimeout(() => {
      copyToast.value = "";
    }, 2000);
  } catch {
    /* silent */
  }
}

async function ctxPin(pinned: boolean) {
  if (!ctxMenu.value || !selectedAccountId.value) return;
  const { dialog } = ctxMenu.value;
  closeCtx();
  try {
    await tgClientApi.pin(selectedAccountId.value, dialog.chatId, pinned);
    // Update local state and reorder
    const idx = dialogs.value.findIndex((d) => d.chatId === dialog.chatId);
    if (idx !== -1) {
      const [d] = dialogs.value.splice(idx, 1);
      d.pinned = pinned;
      if (pinned) dialogs.value.unshift(d);
      else dialogs.value.push(d);
    }
    copyToast.value = pinned ? "Pinned" : "Unpinned";
    if (copyToastTimer) clearTimeout(copyToastTimer);
    copyToastTimer = setTimeout(() => {
      copyToast.value = "";
    }, 2000);
  } catch {
    /* silent */
  }
}

async function ctxLeave() {
  if (!ctxMenu.value || !selectedAccountId.value) return;
  // First click arms the confirmation; second click performs the leave.
  if (!ctxConfirmLeave.value) {
    ctxConfirmLeave.value = true;
    return;
  }
  const { dialog } = ctxMenu.value;
  const isChannel = dialog.type === "channel";
  closeCtx();
  try {
    await tgClientApi.leave(selectedAccountId.value, dialog.chatId);
    // Remove from the dialog list; close the chat if it was open
    const idx = dialogs.value.findIndex((d) => d.chatId === dialog.chatId);
    if (idx !== -1) dialogs.value.splice(idx, 1);
    if (activeChatId.value === dialog.chatId) {
      if (activeChat.value) activeChat.value = { ...activeChat.value, left: true };
    }
    copyToast.value = isChannel ? "Left channel" : "Left group";
    if (copyToastTimer) clearTimeout(copyToastTimer);
    copyToastTimer = setTimeout(() => {
      copyToast.value = "";
    }, 2000);
  } catch (e: any) {
    copyToast.value =
      e?.response?.data?.error ?? e?.message ?? "Failed to leave";
    if (copyToastTimer) clearTimeout(copyToastTimer);
    copyToastTimer = setTimeout(() => {
      copyToast.value = "";
    }, 4000);
  }
}

async function ctxAddToFolder(folder: TgFolder) {
  if (!ctxMenu.value || !selectedAccountId.value) return;
  const { dialog } = ctxMenu.value;
  closeCtx();
  try {
    await tgClientApi.addChatToFolder(selectedAccountId.value, folder.id, dialog.chatId);
    // Update local folder state so the tab filter picks it up immediately
    const local = tgFolders.value.find((f) => f.id === folder.id);
    if (local && !local.includedChatIds.includes(dialog.chatId)) {
      local.includedChatIds.push(dialog.chatId);
    }
    copyToast.value = `Added to ${folder.title}`;
    if (copyToastTimer) clearTimeout(copyToastTimer);
    copyToastTimer = setTimeout(() => { copyToast.value = ""; }, 2000);
  } catch {
    /* silent */
  }
}

// ── Block / report / delete chat ─────────────────────────────────────────────

async function ctxBlock() {
  if (!ctxMenu.value || !selectedAccountId.value) return;
  // First click arms the confirmation; second click blocks
  if (!ctxConfirmBlock.value) {
    ctxConfirmBlock.value = true;
    return;
  }
  const { dialog } = ctxMenu.value;
  closeCtx();
  try {
    await tgClientApi.setBlocked(selectedAccountId.value, dialog.chatId, true);
    if (profileDetails.value?.chatId === dialog.chatId) {
      profileDetails.value = { ...profileDetails.value, blocked: true };
    }
    showToast(`Blocked ${dialog.name}`);
  } catch (e: any) {
    showToast(e?.response?.data?.error ?? e?.message ?? "Failed to block");
  }
}

function ctxReport() {
  if (!ctxMenu.value) return;
  const { dialog } = ctxMenu.value;
  closeCtx();
  reportReason.value = "spam";
  reportComment.value = "";
  reportTarget.value = {
    chatId: dialog.chatId,
    name: dialog.name,
    type: dialog.type,
  };
}

function ctxDeleteChat() {
  if (!ctxMenu.value) return;
  const { dialog } = ctxMenu.value;
  closeCtx();
  deleteChatRevoke.value = true;
  deleteChatTarget.value = dialog;
}

async function confirmDeleteChat() {
  if (!deleteChatTarget.value || !selectedAccountId.value) return;
  const dialog = deleteChatTarget.value;
  deletingChat.value = true;
  try {
    await tgClientApi.deleteHistory(
      selectedAccountId.value,
      dialog.chatId,
      deleteChatRevoke.value,
    );
    deleteChatTarget.value = null;
    const idx = dialogs.value.findIndex((d) => d.chatId === dialog.chatId);
    if (idx !== -1) dialogs.value.splice(idx, 1);
    if (activeChatId.value === dialog.chatId) {
      chatNavStack.value = [];
      closeChat();
    }
    showToast("Chat deleted");
  } catch (e: any) {
    showToast(e?.response?.data?.error ?? e?.message ?? "Failed to delete chat");
  } finally {
    deletingChat.value = false;
  }
}

async function toggleBlockFromProfile() {
  if (!profileDetails.value || !selectedAccountId.value) return;
  const profile = profileDetails.value;
  const next = !profile.blocked;
  blockToggling.value = true;
  try {
    await tgClientApi.setBlocked(selectedAccountId.value, profile.chatId, next);
    profileDetails.value = { ...profile, blocked: next };
    showToast(next ? `Blocked ${profile.name}` : `Unblocked ${profile.name}`);
  } catch (e: any) {
    showToast(e?.response?.data?.error ?? e?.message ?? "Failed to update block");
  } finally {
    blockToggling.value = false;
  }
}

function openReportFromProfile() {
  if (!profileDetails.value) return;
  reportReason.value = "spam";
  reportComment.value = "";
  reportTarget.value = {
    chatId: profileDetails.value.chatId,
    name: profileDetails.value.name,
    type: profileDetails.value.type,
  };
}

async function submitReport() {
  if (!reportTarget.value || !selectedAccountId.value) return;
  const target = reportTarget.value;
  const accountId = selectedAccountId.value;
  reportSending.value = true;
  try {
    await tgClientApi.report(
      accountId,
      target.chatId,
      reportReason.value,
      reportComment.value.trim() || undefined,
    );
    if (target.type === "user" || target.type === "bot") {
      // Reporting a user also blocks them and removes the chat
      await tgClientApi.setBlocked(accountId, target.chatId, true);
      await tgClientApi.deleteHistory(accountId, target.chatId, false);
      const idx = dialogs.value.findIndex((d) => d.chatId === target.chatId);
      if (idx !== -1) dialogs.value.splice(idx, 1);
      if (profileDetails.value?.chatId === target.chatId) {
        profileDetails.value = null;
        showProfile.value = false;
      }
      if (activeChatId.value === target.chatId) {
        chatNavStack.value = [];
        closeChat();
      }
      showToast(`Reported and blocked ${target.name}, chat deleted`);
    } else {
      showToast("Report sent");
    }
    reportTarget.value = null;
  } catch (e: any) {
    showToast(e?.response?.data?.error ?? e?.message ?? "Failed to report");
  } finally {
    reportSending.value = false;
  }
}

// ── Clean account ─────────────────────────────────────────────────────────────

async function onClearAccountCache() {
  if (!selectedAccountId.value || clearingCache.value) return;
  clearingCache.value = true;
  try {
    await tgClientApi.clearAccountCache(selectedAccountId.value);
    // Reset local state so everything refetches fresh
    avatarCache.clear();
    persistAvatarCache();
    contacts.value = [];
    chatNavStack.value = [];
    if (activeChatId.value) closeChat();
    profileDetails.value = null;
    showProfile.value = false;
    await loadDialogs();
    showToast(t("tgc.clearAccountCacheDone"));
  } catch (e: any) {
    showToast(
      e?.response?.data?.error ??
        e?.message ??
        t("tgc.clearAccountCacheFailed"),
    );
  } finally {
    clearingCache.value = false;
  }
}

function openCleanConfirm() {
  if (!selectedAccountId.value) return;
  cleanConfirmChecked.value = false;
  showCleanConfirm.value = true;
}

function closeCleanConfirm() {
  if (cleaning.value) return;
  showCleanConfirm.value = false;
  cleanConfirmChecked.value = false;
}

async function confirmCleanAccount() {
  if (!selectedAccountId.value || cleaning.value) return;
  const accountId = selectedAccountId.value;
  cleaning.value = true;
  try {
    const result = await tgClientApi.cleanAccount(accountId);
    showCleanConfirm.value = false;
    cleanConfirmChecked.value = false;
    // Reset the open chat and reload the (now nearly empty) dialog list
    chatNavStack.value = [];
    if (activeChatId.value) closeChat();
    profileDetails.value = null;
    showProfile.value = false;
    contacts.value = [];
    activeFolder.value = "all";
    await loadDialogs();
    let msg = t("tgc.clean.toastResult")
      .replace("{left}", String(result.left))
      .replace("{deleted}", String(result.deleted))
      .replace("{contacts}", String(result.contacts))
      .replace("{folders}", String(result.folders));
    if (result.failed.length) {
      msg += `, ${t("tgc.clean.toastFailedPart").replace(
        "{n}",
        String(result.failed.length),
      )}`;
    }
    showToast(msg);
  } catch (e: any) {
    showToast(
      e?.response?.data?.error ?? e?.message ?? t("tgc.clean.failed"),
    );
  } finally {
    cleaning.value = false;
  }
}

// ── Message edit / delete / forward ──────────────────────────────────────────

function startEditMessage(msg: TgMessage) {
  editingMsg.value = msg;
  replyingTo.value = null;
  inputText.value = msg.text;
  nextTick(() => {
    inputEl.value?.focus();
    autoResize();
  });
}

function cancelEditMessage() {
  editingMsg.value = null;
  inputText.value = "";
  if (inputEl.value) inputEl.value.style.height = "auto";
}

async function submitEditMessage() {
  const msg = editingMsg.value;
  const text = inputText.value.trim();
  if (!msg || !text || !selectedAccountId.value || !activeChatId.value) return;
  sending.value = true;
  try {
    await tgClientApi.editMessage(
      selectedAccountId.value,
      activeChatId.value,
      msg.id,
      text,
    );
    const local = messages.value.find((m) => m.id === msg.id);
    if (local) {
      local.text = text;
      local.html = null;
    }
    cancelEditMessage();
  } catch (e: any) {
    showToast(e?.response?.data?.error ?? e?.message ?? "Failed to edit");
  } finally {
    sending.value = false;
    await nextTick();
    inputEl.value?.focus();
  }
}

function openDeleteMsg(msg: TgMessage) {
  deleteMsgRevoke.value = true;
  deleteMsgIds.value = [msg.id];
}

function openDeleteSelected() {
  if (!selectedMsgIds.value.size) return;
  deleteMsgRevoke.value = true;
  deleteMsgIds.value = [...selectedMsgIds.value];
}

async function confirmDeleteMsg() {
  if (!deleteMsgIds.value?.length || !selectedAccountId.value || !activeChatId.value)
    return;
  const ids = deleteMsgIds.value;
  deletingMsg.value = true;
  try {
    await tgClientApi.deleteMessages(
      selectedAccountId.value,
      activeChatId.value,
      ids,
      deleteMsgRevoke.value,
    );
    deleteMsgIds.value = null;
    messages.value = messages.value.filter((m) => !ids.includes(m.id));
    if (editingMsg.value && ids.includes(editingMsg.value.id))
      cancelEditMessage();
    exitSelectMode();
    showToast(ids.length > 1 ? `${ids.length} messages deleted` : "Message deleted");
  } catch (e: any) {
    showToast(e?.response?.data?.error ?? e?.message ?? "Failed to delete");
  } finally {
    deletingMsg.value = false;
  }
}

function openForward(msg: TgMessage) {
  forwardFilter.value = "";
  forwardIds.value = [msg.id];
}

function openForwardSelected() {
  if (!selectedMsgIds.value.size) return;
  forwardFilter.value = "";
  forwardIds.value = [...selectedMsgIds.value].sort((a, b) => a - b);
}

function closeForward() {
  forwardIds.value = null;
  forwardFilter.value = "";
}

async function doForward(target: TgDialog) {
  if (!forwardIds.value?.length || !selectedAccountId.value || !activeChatId.value)
    return;
  const ids = forwardIds.value;
  forwardSending.value = true;
  try {
    await tgClientApi.forwardMessages(
      selectedAccountId.value,
      activeChatId.value,
      target.chatId,
      ids,
    );
    closeForward();
    exitSelectMode();
    showToast(`Forwarded to ${target.name}`);
  } catch (e: any) {
    showToast(e?.response?.data?.error ?? e?.message ?? "Failed to forward");
  } finally {
    forwardSending.value = false;
  }
}

// ── Multi-select ─────────────────────────────────────────────────────────────

function enterSelectMode(msg: TgMessage) {
  selectMode.value = true;
  selectedMsgIds.value = new Set([msg.id]);
}

function toggleSelectMsg(msg: TgMessage) {
  const next = new Set(selectedMsgIds.value);
  if (next.has(msg.id)) next.delete(msg.id);
  else next.add(msg.id);
  selectedMsgIds.value = next;
}

function exitSelectMode() {
  selectMode.value = false;
  selectedMsgIds.value = new Set();
}

function onBubbleClick(msg: TgMessage) {
  if (selectMode.value) {
    toggleSelectMsg(msg);
    return;
  }
  activeMsgId.value = activeMsgId.value === msg.id ? null : msg.id;
}

// ── Typing indicators ────────────────────────────────────────────────────────

function onTypingEvent(
  chatId: string,
  userName: string | null,
  cancelled: boolean,
) {
  const existing = typingTimers.get(chatId);
  if (existing) clearTimeout(existing);
  const clearTyping = () => {
    typingTimers.delete(chatId);
    const rest = { ...typingChats.value };
    delete rest[chatId];
    typingChats.value = rest;
  };
  if (cancelled) {
    clearTyping();
    return;
  }
  typingChats.value = { ...typingChats.value, [chatId]: userName };
  // Telegram typing notifications are valid for ~6s unless renewed
  typingTimers.set(chatId, setTimeout(clearTyping, 6000));
}

function isTyping(chatId: string): boolean {
  return chatId in typingChats.value;
}

function typingLabel(chatId: string): string {
  const name = typingChats.value[chatId];
  return name ? `${name} is typing...` : "typing...";
}

function onComposeInput() {
  autoResize();
  notifyTyping();
}

// Throttled -- Telegram expects a SetTyping ping roughly every 5s while typing
function notifyTyping() {
  if (!selectedAccountId.value || !activeChatId.value) return;
  if (!inputText.value.trim()) return;
  const now = Date.now();
  if (now - lastTypingSent < 4000) return;
  lastTypingSent = now;
  tgClientApi
    .sendTyping(selectedAccountId.value, activeChatId.value)
    .catch(() => {});
}

// Returns a data URI from the local cache, or '' if not yet loaded.
// Fetches are triggered by the v-avatar-load directive when the element enters the viewport.
function avatarSrc(chatId: string | null): string {
  if (!chatId) return "";
  const data = avatarCache.get(chatId);
  return data ? `data:image/jpeg;base64,${data}` : "";
}

// Enqueues a chatId at the front (high priority) so visible avatars load before off-screen ones.
function enqueueVisibleAvatar(chatId: string): void {
  if (avatarCache.has(chatId) || avatarFetching.has(chatId) || avatarQueued.has(chatId)) return;
  if (!selectedAccountId.value) return;
  avatarQueue.unshift(chatId);
  avatarQueued.add(chatId);
  drainAvatarQueue();
}

let _avatarObserver: IntersectionObserver | null = null;

function getAvatarObserver(): IntersectionObserver {
  if (!_avatarObserver) {
    _avatarObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const chatId = (entry.target as HTMLElement).dataset.avatarChatId;
        if (chatId) {
          _avatarObserver!.unobserve(entry.target);
          enqueueVisibleAvatar(chatId);
        }
      }
    }, { threshold: 0 });
  }
  return _avatarObserver;
}

// Vue directive -- place on the avatar container element with the chatId as binding value.
// Observes the element and triggers a fetch when it scrolls into the viewport.
const vAvatarLoad = {
  mounted(el: HTMLElement, binding: { value: string | null }) {
    if (!binding.value) return;
    el.dataset.avatarChatId = binding.value;
    if (avatarCache.has(binding.value)) return; // already cached -- no need to observe
    getAvatarObserver().observe(el);
  },
  updated(el: HTMLElement, binding: { value: string | null; oldValue: string | null }) {
    if (binding.value === binding.oldValue) return;
    if (!binding.value) return;
    el.dataset.avatarChatId = binding.value;
    if (!avatarCache.has(binding.value)) getAvatarObserver().observe(el);
  },
  unmounted(el: HTMLElement) {
    _avatarObserver?.unobserve(el);
  },
};

function drainAvatarQueue(): void {
  while (avatarConcurrencyState.active < AVATAR_CONCURRENCY && avatarQueue.length > 0) {
    const chatId = avatarQueue.shift()!;
    avatarQueued.delete(chatId);
    // Skip if cached while waiting in queue
    if (avatarCache.has(chatId) || avatarFetching.has(chatId)) continue;
    if (!selectedAccountId.value) { avatarQueue.unshift(chatId); avatarQueued.add(chatId); break; }
    avatarConcurrencyState.active++;
    avatarFetching.add(chatId);
    const accountId = selectedAccountId.value;
    tgClientApi.avatarsBatch(accountId, [chatId])
      .then((result) => { avatarCache.set(chatId, result[chatId] ?? ""); persistAvatarCache(); })
      .catch(() => { avatarCache.set(chatId, ""); })
      .finally(() => {
        avatarFetching.delete(chatId);
        avatarConcurrencyState.active--;
        drainAvatarQueue();
      });
  }
}

async function openProfile() {
  if (!selectedAccountId.value || !activeChat.value) return;
  if (showProfile.value) {
    showProfile.value = false;
    return;
  }
  showProfile.value = true;
  showThread.value = false;
  profileLoading.value = true;
  profileDetails.value = null;
  try {
    profileDetails.value = await tgClientApi.profile(
      selectedAccountId.value,
      activeChat.value.chatId,
    );
  } catch {
    // Fall back to what we already know from the dialog
    if (activeChat.value) {
      profileDetails.value = {
        chatId: activeChat.value.chatId,
        peerId: displayPeerId(activeChat.value.chatId),
        name: activeChat.value.name,
        type: activeChat.value.type,
        username: activeChat.value.username,
        phone: null,
        bio: null,
        memberCount: null,
        firstName: null,
        lastName: null,
        blocked: null,
      };
    }
  } finally {
    profileLoading.value = false;
  }
  if (profileDetails.value?.type === "group") loadMembers(true);
}

function resetMembers() {
  members.value = [];
  membersTotal.value = 0;
  membersError.value = "";
  memberSearch.value = "";
  memberSearchHits.value = [];
}

// `fresh` starts over from the first page; otherwise the next page is appended.
async function loadMembers(fresh = false) {
  const chatId = profileDetails.value?.chatId;
  if (!selectedAccountId.value || !chatId || membersLoading.value) return;
  if (fresh) resetMembers();
  membersLoading.value = true;
  try {
    const res = await tgClientApi.members(selectedAccountId.value, chatId, {
      limit: MEMBER_PAGE,
      offset: members.value.length,
    });
    const seen = new Set(members.value.map((m) => m.chatId));
    members.value.push(...res.members.filter((m) => !seen.has(m.chatId)));
    membersTotal.value = Math.max(res.total, members.value.length);
  } catch (e: any) {
    membersError.value = friendlyTgError(
      e?.response?.data?.error ?? e?.message ?? "Failed to load members",
    );
  } finally {
    membersLoading.value = false;
  }
}

// Telegram's own search reaches members past the loaded pages; only worth a round-trip
// for a group big enough that the local list is incomplete.
const searchMembersOnServer = debounce(async () => {
  const chatId = profileDetails.value?.chatId;
  const query = memberSearch.value.trim();
  if (!selectedAccountId.value || !chatId || query.length < 2) return;
  if (members.value.length >= membersTotal.value) return;
  try {
    const res = await tgClientApi.members(selectedAccountId.value, chatId, {
      limit: MEMBER_PAGE,
      query,
    });
    memberSearchHits.value = res.members;
  } catch {
    // Local fuzzy matches still stand
  }
}, 350);

function onMemberSearchInput() {
  memberSearchHits.value = [];
  if (memberSearch.value.trim().length >= 2) searchMembersOnServer();
}

const filteredMembers = computed<TgMember[]>(() => {
  const query = memberSearch.value.trim();
  if (!query) return members.value;

  const pool = [...members.value];
  const seen = new Set(pool.map((m) => m.chatId));
  for (const hit of memberSearchHits.value) {
    if (!seen.has(hit.chatId)) pool.push(hit);
  }

  return pool
    .map((m) => ({
      m,
      score: Math.max(
        fuzzyScore(query, m.name),
        m.username ? fuzzyScore(query, m.username) : 0,
      ),
    }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((r) => r.m);
});

// Members are users, so a click opens the DM with them -- same as the contacts list.
function openMemberChat(m: TgMember) {
  showProfile.value = false;
  const existing = dialogs.value.find((d) => d.chatId === m.chatId);
  if (existing) {
    openChat(existing);
    return;
  }
  const synthetic: TgDialog = {
    chatId: m.chatId,
    name: m.name,
    type: m.isBot ? "bot" : "user",
    username: m.username,
    unreadCount: 0,
    lastMessage: null,
  };
  dialogs.value.unshift(synthetic);
  openChat(synthetic);
}

let copyToastTimer: ReturnType<typeof setTimeout> | null = null;

async function copyField(value: string) {
  const ok = await copyText(value);
  copyToast.value = ok ? "Copied!" : t("common.copyFailed");
  if (copyToastTimer) clearTimeout(copyToastTimer);
  copyToastTimer = setTimeout(() => {
    copyToast.value = "";
  }, 2000);
}

// Open a Telegram URL within the messenger if possible, else fall back to browser.
// Plain t.me/username or t.me/username/123 links are resolved and opened in-app.
// Invite links (t.me/+HASH or t.me/joinchat/HASH) show an in-app join confirmation.
// URLs with query params (?start=, ?startapp=), non-numeric path segments (Mini App paths
// like t.me/bot/app), and non-TG URLs all fall through to the browser.
function escMsgText(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>");
}

function linkifyBio(text: string): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>");
  return escaped.replace(
    /(https?:\/\/[^\s<]+)|@([A-Za-z0-9_]{3,})/g,
    (_, url, mention) =>
      url
        ? `<a href="${url.replace(/"/g, '&quot;')}" class="tgc-bio-link">${url}</a>`
        : `<a href="https://t.me/${mention}" class="tgc-bio-link">@${mention}</a>`,
  );
}

function onMsgLinkClick(e: MouseEvent) {
  const a = (e.target as HTMLElement).closest("a");
  if (!a) return;
  const href = a.getAttribute("href");
  if (!href) return;
  e.preventDefault();
  e.stopPropagation();
  handleTgUrl(href);
}

function isMiniAppUrl(url: string): boolean {
  return /[?&]startapp=/i.test(url) || /t(?:elegram)?\.me\/\w+\/\w+/i.test(url);
}

// postMessage bridge for the Telegram Mini App SDK
function onWebViewLoad(e: Event) {
  const iframe = e.target as HTMLIFrameElement;
  try {
    iframe.contentWindow?.postMessage(
      JSON.stringify({
        eventType: "viewport_changed",
        eventData: {
          height: iframe.clientHeight,
          is_expanded: true,
          is_state_stable: true,
        },
      }),
      "*",
    );
  } catch {}
}

async function handleMiniAppMessage(e: MessageEvent) {
  if (!webViewPanel.value) return;
  let eventType: string | undefined;
  try {
    const data = typeof e.data === "string" ? JSON.parse(e.data) : e.data;
    eventType = data?.eventType;
  } catch {
    return;
  }
  if (eventType === "web_app_close") webViewPanel.value = null;
  if (eventType === "web_app_ready") {
    // Send theme params so the mini app can match the UI colour scheme
    (e.source as Window)?.postMessage(
      JSON.stringify({
        eventType: "theme_changed",
        eventData: {
          theme_params: {
            bg_color: "#ffffff",
            text_color: "#1a1a2e",
            hint_color: "#999999",
            link_color: "#4361ee",
            button_color: "#4361ee",
            button_text_color: "#ffffff",
            secondary_bg_color: "#f7f8fc",
          },
        },
      }),
      "*",
    );
  }
  if (eventType === "web_app_open_link") {
    try {
      const data = typeof e.data === "string" ? JSON.parse(e.data) : e.data;
      const url = data?.eventData?.url;
      if (!url) return;
      if (openMiniAppInApp.value && isMiniAppUrl(url)) {
        await handleTgUrl(url);
      } else {
        askOpenLink(url);
      }
    } catch {}
  }
}

async function openMiniApp(
  url: string,
  title: string,
  botChatId?: string | null,
  fromBotMenu = false,
): Promise<void> {
  if (!selectedAccountId.value) {
    window.open(url, "_blank", "noopener");
    return;
  }
  try {
    const { webAppUrl, frameable, signed } = await tgClientApi.webviewResolve(
      selectedAccountId.value,
      url,
      botChatId,
      activeChatId.value,
      fromBotMenu,
    );
    // Said here rather than left to the app: unsigned, it loads and then fails on its own
    // terms ("No initData found"), which reads as the viewer being broken
    if (!signed) showToast("Telegram did not sign this app, so it opens logged out");
    if (!openMiniAppInApp.value) {
      // The resolve happens after the click and can outlive the gesture that lets a popup
      // through, so a blocked window falls back to the chooser and a real click
      if (!window.open(webAppUrl, "_blank", "noopener")) askOpenLink(webAppUrl);
      return;
    }
    if (frameable) {
      webViewPanel.value = { url: webAppUrl, title };
      return;
    }
    // Most apps now refuse to be framed by anything but Telegram, so the panel shows a
    // proxied copy: same page, served from here with those headers dropped, sandboxed into
    // an opaque origin and reached with a ticket that is good for that site alone.
    const { proxyUrl, isolated } = await tgClientApi.webviewTicket(webAppUrl, "app");
    webViewPanel.value = { url: proxyUrl, title, proxied: true, isolated };
  } catch {
    if (!window.open(url, "_blank", "noopener")) askOpenLink(url);
  }
}

// Ask whether to open a link in the Bemby viewer or the external browser
function askOpenLink(url: string) {
  linkChooserUrl.value = url;
}

async function openLinkInBemby() {
  const url = linkChooserUrl.value;
  if (!url || linkOpening.value) return;
  let title = url;
  try {
    title = new URL(url).hostname;
  } catch {}
  // Sites that block framing are routed through the backend web proxy and
  // rendered in a stricter sandbox (no allow-same-origin)
  linkOpening.value = true;
  let frameable = true;
  try {
    ({ frameable } = await tgClientApi.frameable(url));
  } catch {}
  linkOpening.value = false;
  linkChooserUrl.value = null;
  if (frameable) {
    webViewPanel.value = { url, title };
    return;
  }
  // A proxied page is served from Bemby's origin, so its scripts can read the address it was
  // given. That address carries a ticket good only for this one site -- never the session
  // token, which would hand the page the whole API.
  try {
    const { proxyUrl, isolated } = await tgClientApi.webviewTicket(url, "page");
    webViewPanel.value = { url: proxyUrl, title, proxied: true, isolated };
  } catch {
    if (!window.open(url, "_blank", "noopener")) askOpenLink(url);
  }
}

function openLinkInBrowser() {
  const url = linkChooserUrl.value;
  if (!url) return;
  linkChooserUrl.value = null;
  window.open(url, "_blank", "noopener");
}

async function handleTgUrl(url: string) {
  // Non-Telegram links always go through the chooser
  if (!/https?:\/\/t(?:elegram)?\.me\//i.test(url)) {
    askOpenLink(url);
    return;
  }
  if (!selectedAccountId.value) {
    window.open(url, "_blank", "noopener");
    return;
  }

  // Invite links: t.me/+HASH or t.me/joinchat/HASH
  const inviteM =
    url.match(/https?:\/\/t(?:elegram)?\.me\/\+([A-Za-z0-9_-]+)/i) ??
    url.match(/https?:\/\/t(?:elegram)?\.me\/joinchat\/([A-Za-z0-9_-]+)/i);
  if (inviteM) {
    const hash = inviteM[1];
    checkingInvite.value = true;
    try {
      const preview = await tgClientApi.checkInvite(
        selectedAccountId.value,
        hash,
      );
      if (preview.alreadyJoined && preview.chatId) {
        await openChat({
          chatId: preview.chatId,
          name: preview.title,
          type: preview.type,
          username: null,
          unreadCount: 0,
          lastMessage: null,
        }, true);
      } else {
        invitePreview.value = preview;
      }
    } catch {
      copyToast.value =
        "Could not load group info -- try the official Telegram app";
      if (copyToastTimer) clearTimeout(copyToastTimer);
      copyToastTimer = setTimeout(() => {
        copyToast.value = "";
      }, 4000);
    } finally {
      checkingInvite.value = false;
    }
    return;
  }

  // Mini App links: t.me/bot?startapp=HASH or t.me/bot/appname
  if (isMiniAppUrl(url)) {
    await openMiniApp(url, "Mini App");
    return;
  }

  // Bot deep links: t.me/botname?start=PARAM -- open bot and send the start param
  const startM = url.match(
    /https?:\/\/t(?:elegram)?\.me\/([A-Za-z]\w+)[?&]start=([^&]+)/i,
  );
  if (startM) {
    const [, botUsername, startParam] = startM;
    try {
      const dialog = await tgClientApi.startBot(
        selectedAccountId.value,
        botUsername,
        decodeURIComponent(startParam),
      );
      await openChat(dialog, true);
      // Fetch messages after a short delay so the bot reply is visible
      setTimeout(refreshMessages, 1500);
    } catch (e: any) {
      const raw = e?.response?.data?.error ?? e?.message ?? "Could not start bot";
      copyToast.value = raw;
      if (copyToastTimer) clearTimeout(copyToastTimer);
      copyToastTimer = setTimeout(() => { copyToast.value = ""; }, 4000);
    }
    return;
  }

  // Username or username/messageId links
  const m = url.match(
    /https?:\/\/t(?:elegram)?\.me\/([A-Za-z]\w+)(?:\/(\d+))?(?:[?#].*)?$/i,
  );
  const username = m?.[1];
  if (
    username &&
    username.toLowerCase() !== "joinchat" &&
    username.toLowerCase() !== "s"
  ) {
    try {
      const dialog = await tgClientApi.resolvePeer(
        selectedAccountId.value,
        username,
      );
      await openChat(dialog, true);
      return;
    } catch {
      // Peer not found or resolve failed
    }
  }

  // Never open t.me links in the browser -- show a toast if we couldn't handle it
  copyToast.value = "Could not open this Telegram link in the messenger";
  if (copyToastTimer) clearTimeout(copyToastTimer);
  copyToastTimer = setTimeout(() => { copyToast.value = ""; }, 4000);
}

function openGoUrlDialog() {
  goUrlInput.value = "";
  showGoUrlDialog.value = true;
  nextTick(() => goUrlInputEl.value?.focus());
}

async function submitGoUrl() {
  let url = goUrlInput.value.trim();
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  showGoUrlDialog.value = false;
  goUrlInput.value = "";

  if (!selectedAccountId.value) {
    askOpenLink(url);
    return;
  }

  // Invite links, username links, bot /start links → navigate in messenger chat
  const isTgChatLink =
    /https?:\/\/t(?:elegram)?\.me\/(\+|joinchat\/)/i.test(url) ||
    (/https?:\/\/t(?:elegram)?\.me\/[A-Za-z]\w+([?&]start=)/i.test(url) &&
      !isMiniAppUrl(url)) ||
    (/https?:\/\/t(?:elegram)?\.me\/[A-Za-z]\w+(?:\/\d+)?(?:[?#].*)?$/i.test(url) &&
      !isMiniAppUrl(url));
  if (isTgChatLink) {
    await handleTgUrl(url);
    return;
  }

  // Mini app URLs → resolve authenticated URL then open in messenger webview,
  // falling back to the external browser when the site refuses framing
  if (isMiniAppUrl(url)) {
    try {
      const res = await tgClientApi.webviewResolve(selectedAccountId.value, url);
      if (res.frameable) {
        webViewPanel.value = { url: res.webAppUrl, title: "Mini App" };
        return;
      }
      window.open(res.webAppUrl, "_blank", "noopener");
    } catch {
      window.open(url, "_blank", "noopener");
    }
    return;
  }

  // Arbitrary URL → ask whether to open in the Bemby viewer or the browser
  askOpenLink(url);
}

async function confirmJoinInvite() {
  if (!invitePreview.value || !selectedAccountId.value) return;
  joiningInvite.value = true;
  const hash = invitePreview.value.hash;
  try {
    const dialog = await tgClientApi.joinInvite(selectedAccountId.value, hash);
    invitePreview.value = null;
    await openChat(dialog, true);
  } catch (e: any) {
    const raw = e?.response?.data?.error ?? e?.message ?? "Failed to join";
    copyToast.value = friendlyTgError(raw);
    if (copyToastTimer) clearTimeout(copyToastTimer);
    copyToastTimer = setTimeout(() => {
      copyToast.value = "";
    }, 4000);
  } finally {
    joiningInvite.value = false;
  }
}

function stopMembershipPoll() {
  if (membershipPollTimer !== null) {
    clearInterval(membershipPollTimer);
    membershipPollTimer = null;
  }
}

function stopBotMsgWatch() {
  botMsgWatchGen++;
  if (botMsgWatchTimer !== null) {
    clearTimeout(botMsgWatchTimer);
    botMsgWatchTimer = null;
  }
}

// Start polling the active bot chat's last message every 2s until it stops changing.
// Safe to call multiple times -- no-ops if a watch is already scheduled.
function scheduleBotMsgWatch() {
  const lastMsg = messages.value[messages.value.length - 1];
  if (!lastMsg || lastMsg.fromMe || activeChat.value?.type !== 'bot') return;
  if (botMsgWatchTimer !== null) return; // already running

  botMsgWatchText = lastMsg.text;
  botMsgWatchStaleTicks = 0;
  botMsgWatchTotalTicks = 0;
  const gen = ++botMsgWatchGen;

  const tick = async () => {
    if (botMsgWatchGen !== gen) return;
    botMsgWatchTimer = null;

    await refreshMessages();

    if (botMsgWatchGen !== gen) return; // stopped while fetching

    const current = messages.value[messages.value.length - 1];
    if (!current || current.fromMe || activeChat.value?.type !== 'bot') return;

    botMsgWatchTotalTicks++;
    if (current.text === botMsgWatchText) {
      botMsgWatchStaleTicks++;
    } else {
      botMsgWatchText = current.text;
      botMsgWatchStaleTicks = 0;
    }

    // Stop after 3 unchanged polls or 20 total polls (~40s safety cap)
    if (botMsgWatchStaleTicks < 3 && botMsgWatchTotalTicks < 20) {
      botMsgWatchTimer = setTimeout(tick, 2000);
    }
  };

  botMsgWatchTimer = setTimeout(tick, 2000);
}

async function checkMembershipStatus(): Promise<void> {
  if (!selectedAccountId.value || !joinRequestSent.value) return;
  // Use the stored group chatId -- activeChatId may be the verification bot DM, not the group
  const groupChatId = pendingJoinChatId.value ?? activeChatId.value;
  if (!groupChatId) return;
  try {
    const { member } = await tgClientApi.membership(selectedAccountId.value, groupChatId);
    if (member) {
      stopMembershipPoll();
      joinRequestSent.value = false;
      pendingJoinChatId.value = null;
      // Update the group in the dialogs list
      const existing = dialogs.value.find((d) => d.chatId === groupChatId);
      const joined = existing ? { ...existing, left: false } : null;
      if (joined) {
        dialogs.value = dialogs.value.map((d) => (d.chatId === groupChatId ? joined : d));
      }
      // If currently viewing the group, refresh it
      if (activeChatId.value === groupChatId && activeChat.value) {
        activeChat.value = { ...activeChat.value, left: false };
        await fetchMessages(true);
      }
    }
  } catch {
    // silently ignore -- will retry on next poll
  }
}

// After a join request, detect if a verification bot sent a private message and open it.
async function checkForVerificationBot(joinTimeSec: number) {
  if (!joinRequestSent.value || !selectedAccountId.value) return;
  try {
    const fresh = await tgClientApi.dialogs(selectedAccountId.value, { limit: 30 });
    const verifyBot = fresh.find(
      (d) =>
        d.type === "bot" &&
        d.lastMessage !== null &&
        d.lastMessage.date >= joinTimeSec - 5 &&
        d.chatId !== activeChatId.value,
    );
    if (verifyBot) {
      if (!dialogs.value.find((d) => d.chatId === verifyBot.chatId)) {
        dialogs.value.unshift(verifyBot);
      }
      // Save join state -- openChat will clear it
      const savedGroupChatId = pendingJoinChatId.value;
      await openChat(verifyBot, true);
      // Restore join state so the membership poll keeps checking the group
      if (savedGroupChatId) {
        joinRequestSent.value = true;
        pendingJoinChatId.value = savedGroupChatId;
        startMembershipPoll();
      }
    }
  } catch {
    // silently ignore
  }
}

function startMembershipPoll() {
  stopMembershipPoll();
  // Poll every 8 seconds while the join request is pending
  membershipPollTimer = setInterval(checkMembershipStatus, 8_000);
}

async function joinCurrentChat() {
  if (!selectedAccountId.value || !activeChatId.value || !activeChat.value)
    return;
  joiningChannel.value = true;
  try {
    const result = await tgClientApi.join(
      selectedAccountId.value,
      activeChatId.value,
    );
    if (result.requestSent) {
      const joinTimeSec = Math.floor(Date.now() / 1000);
      joinRequestSent.value = true;
      pendingJoinChatId.value = activeChatId.value;
      startMembershipPoll();
      // Initial fetch -- bot may not have replied yet
      await fetchMessages(true);
      // Re-fetch at 2s and 6s so the bot's verification message appears as soon as it arrives
      setTimeout(refreshMessages, 2_000);
      setTimeout(refreshMessages, 6_000);
      // Check if a verification bot sent a private message and open it automatically
      setTimeout(() => checkForVerificationBot(joinTimeSec), 3_000);
      setTimeout(() => checkForVerificationBot(joinTimeSec), 8_000);
    } else {
      const joinTimeSec = Math.floor(Date.now() / 1000);
      const joined = { ...activeChat.value, left: false };
      activeChat.value = joined;
      // Add to dialogs list so the "not-in-dialogs = not a member" heuristic stays correct
      if (!dialogs.value.find((d) => d.chatId === joined.chatId)) {
        dialogs.value.unshift(joined);
      }
      await fetchMessages(true);
      setTimeout(refreshMessages, 2_000);
      // Check if a bot immediately sent a verification private message
      setTimeout(() => checkForVerificationBot(joinTimeSec), 3_000);
    }
  } catch (e: any) {
    const raw = e?.response?.data?.error ?? e?.message ?? "Failed to join";
    copyToast.value = friendlyTgError(raw);
    if (copyToastTimer) clearTimeout(copyToastTimer);
    copyToastTimer = setTimeout(() => {
      copyToast.value = "";
    }, 8000);
    // Private chats need an invite link -- open the URL dialog so it can be pasted
    if (raw.includes("CHANNEL_PRIVATE")) openGoUrlDialog();
  } finally {
    joiningChannel.value = false;
  }
}

async function clickInlineButton(
  msg: TgMessage,
  btn: {
    text: string;
    data: string | null;
    url: string | null;
    webApp: boolean;
    send: boolean;
    requestPhone: boolean;
  },
  ri: number,
  bi: number,
) {
  if (!selectedAccountId.value || !activeChatId.value) return;
  const key = `${msg.id}-${ri}-${bi}`;
  // "Share my phone number": ask first, then send our number as a contact card
  if (btn.requestPhone) {
    sharePhoneUseCustom.value = false;
    sharePhoneCustom.value = "";
    sharePhoneIgnoreCheck.value = false;
    sharePhoneTarget.value = { msgId: msg.id, key, chatName: activeChat.value?.name ?? "this bot" };
    return;
  }
  // Reply-keyboard button: send its label back as a normal message
  if (btn.send && !btn.data && !btn.url) {
    if (sending.value || !btn.text) return;
    btnLoadingKey.value = key;
    try {
      inputText.value = btn.text;
      await sendMessage();
    } finally {
      btnLoadingKey.value = null;
    }
    return;
  }
  if (btn.url) {
    btnLoadingKey.value = key;
    try {
      if (btn.webApp) {
        // Pass the sender as the bot context; private chats omit fromId, so
        // fall back to the chat itself (the bot we are talking to)
        const botChatId =
          msg.fromId ??
          (activeChat.value?.type === "bot" || activeChat.value?.type === "user"
            ? activeChatId.value
            : null);
        await openMiniApp(btn.url, btn.text || "Mini App", botChatId);
      } else {
        await handleTgUrl(btn.url);
      }
    } finally {
      btnLoadingKey.value = null;
    }
    return;
  }
  if (!btn.data) return;
  btnLoadingKey.value = key;
  try {
    const res = await tgClientApi.clickButton(
      selectedAccountId.value,
      activeChatId.value,
      msg.id,
      btn.data,
    );
    if (res.message) {
      copyToast.value = res.message;
      if (copyToastTimer) clearTimeout(copyToastTimer);
      copyToastTimer = setTimeout(() => {
        copyToast.value = "";
      }, 4000);
    }
    if (res.url) await handleTgUrl(res.url);
  } catch (e: any) {
    const raw = e?.response?.data?.error ?? e?.message ?? "Button click failed";
    if (raw.includes("MESSAGE_ID_INVALID")) {
      if (joinRequestSent.value && activeChat.value?.left) {
        // Non-member clicking a button in a group they haven't been approved for yet
        copyToast.value = "Complete the verification in the bot's private message first.";
      } else {
        copyToast.value = "Message was updated by the bot -- refreshing...";
        refreshMessages();
      }
    } else if (raw.includes("BOT_RESPONSE_TIMEOUT")) {
      // Bot received the click but didn't answer the callback -- action was likely still processed
    } else {
      copyToast.value = friendlyTgError(raw);
    }
    if (copyToastTimer) clearTimeout(copyToastTimer);
    copyToastTimer = setTimeout(() => {
      copyToast.value = "";
    }, 4000);
  } finally {
    btnLoadingKey.value = null;
    // Re-fetch twice to pick up the bot's immediate edits, then start the watcher
    // for bots that stream/progressively edit their message.
    setTimeout(refreshMessages, 1200);
    setTimeout(() => { refreshMessages(); scheduleBotMsgWatch(); }, 3500);
    // Check membership after bot interaction -- covers both the group view and the bot DM
    if (joinRequestSent.value && pendingJoinChatId.value) {
      setTimeout(checkMembershipStatus, 4000);
    }
  }
}

// Sends our own number as a contact card, the only form a bot accepts for a
// "share phone number" keyboard button.
async function confirmSharePhone() {
  const target = sharePhoneTarget.value;
  if (!target || !selectedAccountId.value || !activeChatId.value) return;
  if (!sharePhoneReady.value) return;
  sharingPhone.value = true;
  btnLoadingKey.value = target.key;
  try {
    const res = await tgClientApi.sharePhone(
      selectedAccountId.value,
      activeChatId.value,
      target.msgId,
      sharePhoneUseCustom.value ? sharePhoneCustom.value.trim() : undefined,
    );
    sharePhoneTarget.value = null;
    messages.value.push({
      id: res.id,
      text: res.text,
      html: null,
      date: res.date,
      fromMe: true,
      isRead: false,
      fromId: null,
      fromName: null,
      hasPhoto: false,
      hasDocument: false,
      hasSticker: false,
      fileName: null,
      buttons: null,
      reactions: null,
      replyToId: null,
      replyToText: null,
      replyToName: null,
      replyCount: null,
    });
    await scrollBottom(true);
    const idx = dialogs.value.findIndex((d) => d.chatId === activeChatId.value);
    if (idx !== -1) {
      dialogs.value[idx] = {
        ...dialogs.value[idx],
        lastMessage: { text: res.text, date: res.date, fromMe: true },
      };
      const [moved] = dialogs.value.splice(idx, 1);
      dialogs.value.unshift(moved);
    }
    setTimeout(refreshMessages, 1500);
    setTimeout(refreshMessages, 4000);
  } catch (e: any) {
    const raw =
      e?.response?.data?.error ?? e?.message ?? "Sharing phone number failed";
    copyToast.value = friendlyTgError(raw);
    if (copyToastTimer) clearTimeout(copyToastTimer);
    copyToastTimer = setTimeout(() => {
      copyToast.value = "";
    }, 4000);
  } finally {
    sharingPhone.value = false;
    btnLoadingKey.value = null;
  }
}

// Silently re-fetch the latest messages and merge edits/new messages in-place.
async function refreshMessages() {
  if (!selectedAccountId.value || !activeChatId.value) return;
  try {
    const msgs = await tgClientApi.messages(
      selectedAccountId.value,
      activeChatId.value,
      { limit: 20, fresh: 1 },
    );
    const fresh = msgs.reverse(); // oldest first
    if (!fresh.length) return;

    const freshIds = new Set(fresh.map((m) => m.id));
    const oldestFreshId = fresh[0].id;

    // Remove messages the server no longer returns within the fresh ID range --
    // these were deleted by the bot/user after we last loaded them.
    messages.value = messages.value.filter(
      (m) => m.id < oldestFreshId || freshIds.has(m.id),
    );

    let appended = false;
    const lastId = messages.value[messages.value.length - 1]?.id ?? 0;
    for (const msg of fresh) {
      const idx = messages.value.findIndex((m) => m.id === msg.id);
      if (idx !== -1) {
        messages.value[idx] = msg; // update edited messages in-place
      } else if (msg.id > lastId) {
        messages.value.push(msg);
        if (!scrolledToBottom && !msg.fromMe) jumpUnseenCount.value++;
        appended = true;
      }
    }
    if (appended) await scrollBottom(false);

    // Sync the sidebar last-message for this chat -- the bot may have edited it
    const chatId = activeChatId.value;
    const newestMsg = messages.value[messages.value.length - 1];
    if (newestMsg && chatId) {
      const di = dialogs.value.findIndex((d) => d.chatId === chatId);
      if (di !== -1) {
        dialogs.value[di] = {
          ...dialogs.value[di],
          lastMessage: { text: newestMsg.text, date: newestMsg.date, fromMe: newestMsg.fromMe },
        };
      }
    }
  } catch {
    // Silent -- best effort
  }
}

// ── Bot commands and menu button ──────────────────────────────────────────────

async function loadBotCommands(chatId: string) {
  botMenuButton.value = null;
  if (!selectedAccountId.value) return;
  try {
    const info = await tgClientApi.botInfo(selectedAccountId.value, chatId);
    botCommands.value = info.commands;
    botMenuButton.value = info.menuButton;
  } catch {
    botCommands.value = [];
    botMenuButton.value = null;
  }
}

/**
 * Opens the bot's pinned Mini App. Flagged as coming from the menu button, which is what
 * makes Telegram sign it: the address is the bot's registered one rather than a button in
 * a message, and asked for any other way it comes back without the account data.
 */
function openBotMenuApp() {
  const button = botMenuButton.value;
  if (!button) return;
  void openMiniApp(button.url, button.text, activeChatId.value, true);
}

function openCommandMenu() {
  if (!inputText.value.startsWith("/")) {
    inputText.value = "/";
    autoResize();
  }
  nextTick(() => {
    inputEl.value?.focus();
    const el = inputEl.value;
    if (el) el.setSelectionRange(el.value.length, el.value.length);
  });
}

function selectCommand(cmd: TgBotCommand) {
  inputText.value = `/${cmd.command}`;
  sendMessage();
}

function showToast(msg: string, ms = 3000) {
  copyToast.value = msg;
  if (copyToastTimer) clearTimeout(copyToastTimer);
  copyToastTimer = setTimeout(() => {
    copyToast.value = "";
  }, ms);
}

// ── Reply ─────────────────────────────────────────────────────────────────────

function startReply(msg: TgMessage) {
  replyingTo.value = msg;
  nextTick(() => inputEl.value?.focus());
}

function scrollToReply(replyToId: number) {
  const el = messagesEl.value;
  if (!el) return;
  const target = el.querySelector(`[data-msg-id="${replyToId}"]`);
  if (!target) return;
  target.scrollIntoView({ behavior: "smooth", block: "center" });
  target.classList.add("tgc-msg-highlighted");
  setTimeout(() => target.classList.remove("tgc-msg-highlighted"), 1500);
}

// ── Reactions ─────────────────────────────────────────────────────────────────

function openReactPicker(msg: TgMessage, e: MouseEvent) {
  e.stopPropagation();
  emojiPickerMsgId.value = msg.id;
  const btn = e.currentTarget as HTMLElement;
  const rect = btn.getBoundingClientRect();
  emojiPickerPos.value = { x: rect.left - 40, y: rect.top };
}

async function doReact(msgId: number, emoji: string) {
  if (!selectedAccountId.value || !activeChatId.value) return;
  const msg =
    messages.value.find((m) => m.id === msgId) ??
    threadMessages.value.find((m) => m.id === msgId);
  const existing = msg?.reactions?.find((r) => r.emoji === emoji);
  const sendEmoji = existing?.mine ? null : emoji;
  try {
    await tgClientApi.sendReaction(
      selectedAccountId.value,
      activeChatId.value,
      msgId,
      sendEmoji,
    );
    // Optimistic update
    if (msg) {
      if (sendEmoji) {
        if (existing) {
          existing.mine = true;
          existing.count++;
        } else {
          if (!msg.reactions) msg.reactions = [];
          msg.reactions.push({ emoji, count: 1, mine: true });
        }
      } else if (existing) {
        existing.mine = false;
        existing.count = Math.max(0, existing.count - 1);
        msg.reactions = msg.reactions!.filter((r) => r.count > 0);
        if (!msg.reactions.length) msg.reactions = null;
      }
    }
    setTimeout(refreshMessages, 1500);
  } catch (e: any) {
    showToast(e?.response?.data?.error ?? e?.message ?? "Failed to react");
  }
}

async function pickReaction(emoji: string) {
  const msgId = emojiPickerMsgId.value;
  emojiPickerMsgId.value = null;
  if (msgId === null) return;
  await doReact(msgId, emoji);
}

// ── Thread / comments ─────────────────────────────────────────────────────────

async function openThread(msg: TgMessage) {
  if (!selectedAccountId.value || !activeChatId.value) return;
  threadRootMsg.value = msg;
  showThread.value = true;
  showProfile.value = false;
  loadingThread.value = true;
  threadMessages.value = [];
  try {
    const msgs = await tgClientApi.threadMessages(
      selectedAccountId.value,
      activeChatId.value,
      msg.id,
    );
    threadMessages.value = msgs.reverse();
    await nextTick();
    if (threadEl.value) threadEl.value.scrollTop = threadEl.value.scrollHeight;
  } catch (e: any) {
    showToast(
      e?.response?.data?.error ?? e?.message ?? "Failed to load thread",
    );
  } finally {
    loadingThread.value = false;
  }
}

async function sendThreadMessage() {
  const text = threadInputText.value.trim();
  if (
    !text ||
    !selectedAccountId.value ||
    !activeChatId.value ||
    !threadRootMsg.value ||
    sendingThread.value
  )
    return;
  sendingThread.value = true;
  threadInputText.value = "";
  try {
    const result = await tgClientApi.send(
      selectedAccountId.value,
      activeChatId.value,
      text,
      threadRootMsg.value.id,
    );
    threadMessages.value.push({
      id: result.id,
      text,
      html: null,
      date: result.date,
      fromMe: true,
      isRead: false,
      fromId: null,
      fromName: null,
      hasPhoto: false,
      hasDocument: false,
      hasSticker: false,
      fileName: null,
      buttons: null,
      reactions: null,
      replyToId: threadRootMsg.value.id,
      replyToText: threadRootMsg.value.text,
      replyToName: null,
      replyCount: null,
    });
    await nextTick();
    if (threadEl.value) threadEl.value.scrollTop = threadEl.value.scrollHeight;
    // Update reply count on root message
    const root = messages.value.find((m) => m.id === threadRootMsg.value!.id);
    if (root && root.replyCount !== null) root.replyCount++;
  } catch (e: any) {
    showToast(e?.response?.data?.error ?? e?.message ?? "Failed to send reply");
  } finally {
    sendingThread.value = false;
  }
}

function avatarLetter(name: string) {
  return (name || "?").trim()[0].toUpperCase();
}

const SENDER_COLOURS = [
  "#4361ee",
  "#e63946",
  "#2ec4b6",
  "#f4a261",
  "#7209b7",
  "#118ab2",
  "#06d6a0",
  "#ff6b6b",
];

function senderColor(fromId: string | null): string {
  if (!fromId) return SENDER_COLOURS[0];
  let h = 0;
  for (let i = 0; i < fromId.length; i++)
    h = ((h << 5) - h + fromId.charCodeAt(i)) | 0;
  return SENDER_COLOURS[Math.abs(h) % SENDER_COLOURS.length];
}

// Owners/admins posting anonymously (or as the group) carry no fromId -- Telegram
// attributes those to the group itself, so fall back to the group's icon and title.
function senderAvatarId(msg: TgMessage): string | null {
  return msg.fromId ?? activeChat.value?.chatId ?? null;
}

function senderLabel(msg: TgMessage): string | null {
  if (msg.fromName) return msg.fromName;
  const chat = activeChat.value;
  if (!chat || chat.type !== "group") return null;
  return !msg.fromId || msg.fromId === chat.chatId ? chat.name : null;
}

function showSenderAvatar(idx: number): boolean {
  const msg = messages.value[idx];
  if (msg.fromMe) return false;
  const chat = activeChat.value;
  if (!chat || chat.type !== "group") return false;
  const next = messages.value[idx + 1];
  // A service notice breaks a run, so the message above it keeps its avatar
  return (
    !next ||
    next.fromMe ||
    Boolean(next.service) ||
    senderAvatarId(next) !== senderAvatarId(msg)
  );
}

// The grey centred line Telegram shows for joins, leaves and renames.
function serviceText(msg: TgMessage): string {
  const service = msg.service;
  if (!service) return "";
  const someone = t("tgc.service.someone");
  const who = msg.fromMe
    ? t("tgc.searchYou")
    : (service.actorName ?? someone);
  const targets =
    service.targets.map((x) => x.name ?? someone).join(", ") || someone;
  return t(`tgc.service.${service.kind}`)
    .replace("{name}", who)
    .replace("{targets}", targets)
    .replace("{title}", service.title ?? "");
}

function fmtTime(ts: number) {
  const d = new Date(ts * 1000);
  const now = new Date();
  const diffDays = Math.floor((now.getTime() - d.getTime()) / 86_400_000);
  if (diffDays === 0)
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (diffDays < 7) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { day: "2-digit", month: "2-digit" });
}

function fmtMsgTime(ts: number) {
  return new Date(ts * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtDate(ts: number) {
  return new Date(ts * 1000).toLocaleDateString([], {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

function sameDay(a: number, b: number) {
  const da = new Date(a * 1000);
  const db = new Date(b * 1000);
  return da.toDateString() === db.toDateString();
}

function photoUrl(msgId: number) {
  if (!selectedAccountId.value || !activeChatId.value) return "";
  return tgClientApi.photoUrl(
    selectedAccountId.value,
    activeChatId.value,
    msgId,
  );
}

async function scrollBottom(force = false) {
  if (!scrolledToBottom && !force) return;
  await nextTick();
  if (messagesEl.value) {
    messagesEl.value.scrollTop = messagesEl.value.scrollHeight;
  }
}

// Scroll to the first unread message when opening a chat with unread messages.
// Falls back to scrolling to the bottom when all loaded messages are unread
// (meaning there are more unread messages further back) or when there are none.
async function scrollToUnread(): Promise<void> {
  await nextTick();
  const el = messagesEl.value;
  if (!el) return;
  if (!firstUnreadId.value) {
    el.scrollTop = el.scrollHeight;
    return;
  }
  const target = el.querySelector(
    `[data-msg-id="${firstUnreadId.value}"]`,
  ) as HTMLElement | null;
  if (target) {
    el.scrollTop = target.offsetTop - el.offsetTop - 60;
  } else {
    el.scrollTop = el.scrollHeight;
  }
}

function onMsgScroll() {
  const el = messagesEl.value;
  if (!el) return;
  scrolledToBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 40;
  // Show the jump button only once meaningfully away from the bottom
  jumpBtnVisible.value = el.scrollHeight - el.scrollTop - el.clientHeight > 300;
  if (scrolledToBottom) jumpUnseenCount.value = 0;
  if (el.scrollTop <= 60 && canLoadMore.value && !loadingOlder.value && messages.value.length >= 30) {
    loadOlderMessages();
  }
}

function autoResize() {
  const el = inputEl.value;
  if (!el) return;
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 120) + "px";
}

// ── Account change ────────────────────────────────────────────────────────────

async function onAccountChange() {
  closeLiveSocket();
  dialogs.value = [];
  activeChatId.value = null;
  activeChat.value = null;
  messages.value = [];
  contacts.value = [];
  clearSearch();
  showMobileChat.value = false;
  activeFolder.value = "all";
  tgFolders.value = [];
  showThread.value = false;
  replyingTo.value = null;
  editingMsg.value = null;
  exitSelectMode();
  typingTimers.forEach((timer) => clearTimeout(timer));
  typingTimers.clear();
  typingChats.value = {};
  botCommands.value = [];
  botMenuButton.value = null;
  saveMessengerState();
  await loadDialogs();
  startLiveSocket();
}

// ── Dialogs ───────────────────────────────────────────────────────────────────

// Maps raw Telegram API error strings to human-readable guidance.
function friendlyTgError(raw: string): string {
  if (raw.includes("AUTH_KEY_DUPLICATED"))
    return "Session conflict: this account is already connected elsewhere. Click Reconnect to fix this.";
  if (raw.includes("AUTH_KEY_INVALID") || raw.includes("AUTH_KEY_UNREGISTERED"))
    return "Session is no longer valid. Click Reconnect or re-authenticate this account.";
  if (raw.includes("SESSION_REVOKED") || raw.includes("SESSION_EXPIRED"))
    return "This session was revoked (e.g. via Telegram Settings > Devices). Please reconnect.";
  if (raw.includes("USER_DEACTIVATED"))
    return "This Telegram account has been deactivated.";
  if (raw.includes("FLOOD_WAIT"))
    return "Too many requests -- Telegram has asked us to slow down. Please wait a moment and try again.";
  if (raw.includes("PHONE_NUMBER_BANNED"))
    return "This phone number is banned from Telegram.";
  if (raw.includes("CHANNEL_PRIVATE"))
    return "This group/channel is private and can only be joined with an invite link (t.me/+...).";
  if (raw.includes("INVITE_HASH_EXPIRED"))
    return "This invite link has expired or been revoked. Ask for a new one.";
  if (raw.includes("USER_ALREADY_PARTICIPANT"))
    return "This account is already a member of this chat.";
  if (
    raw.includes("CONNECTION") ||
    raw.includes("NETWORK") ||
    raw.includes("ECONNREFUSED")
  )
    return "Network error connecting to Telegram. Check your server connection and try again.";
  return raw;
}

async function reconnectAccount() {
  if (!selectedAccountId.value || reconnecting.value) return;
  reconnecting.value = true;
  dialogError.value = "";
  try {
    await tgClientApi.reconnect(selectedAccountId.value);
    await loadDialogs();
  } catch (e: any) {
    dialogError.value = friendlyTgError(
      e?.response?.data?.error ?? e?.message ?? "Reconnect failed",
    );
  } finally {
    reconnecting.value = false;
  }
}

async function loadDialogs() {
  // A long-lived tab outlives one ticket, and a stale one shows every photo as broken
  await tgClientApi.ensureMediaTicket().catch(() => {});
  if (!selectedAccountId.value) return;
  loadingDialogs.value = true;
  dialogError.value = "";
  const accountId = selectedAccountId.value;
  try {
    // Load first 30 and folders in parallel -- show UI immediately
    const [firstBatch, folders] = await Promise.all([
      tgClientApi.dialogs(accountId, { limit: 200 }),
      tgClientApi.folders(accountId).catch(() => []),
    ]);
    // Only apply if the account hasn't changed while we were waiting
    if (selectedAccountId.value !== accountId) return;
    dialogs.value = firstBatch;
    tgFolders.value = folders;
    loadingDialogs.value = false;

  } catch (e: any) {
    const raw =
      e?.response?.data?.error ?? e?.message ?? "Failed to load chats";
    dialogError.value = friendlyTgError(raw);
    loadingDialogs.value = false;
  }
}

// ── Search ────────────────────────────────────────────────────────────────────

function clearSearch() {
  if (searchTimer.value) clearTimeout(searchTimer.value);
  searchQuery.value = "";
  searchResults.value = null;
  searchLoading.value = false;
  searchError.value = null;
}

function onSearchInput() {
  if (searchTimer.value) clearTimeout(searchTimer.value);
  const q = searchQuery.value.trim();
  searchError.value = null;
  if (!q) {
    searchResults.value = null;
    searchLoading.value = false;
    return;
  }

  // First filter local dialogs immediately
  searchResults.value = dialogs.value.filter(
    (d) =>
      d.name.toLowerCase().includes(q.toLowerCase()) ||
      d.username?.toLowerCase().includes(q.toLowerCase()),
  );

  // Then fetch from Telegram after debounce
  searchLoading.value = true;
  searchTimer.value = setTimeout(async () => {
    if (!selectedAccountId.value) {
      searchLoading.value = false;
      return;
    }
    try {
      const remote = await tgClientApi.search(selectedAccountId.value, q);
      // A newer keystroke may have superseded this request
      if (searchQuery.value.trim() !== q) return;
      // Merge remote results, dedup by chatId
      const seen = new Set(searchResults.value?.map((d) => d.chatId));
      const merged = [...(searchResults.value ?? [])];
      for (const r of remote) {
        if (!seen.has(r.chatId)) merged.push(r);
      }
      searchResults.value = merged;
    } catch (e: any) {
      if (searchQuery.value.trim() !== q) return;
      const raw = e?.response?.data?.error ?? e?.message ?? "Search failed";
      searchError.value = friendlyTgError(raw);
    } finally {
      if (searchQuery.value.trim() === q) searchLoading.value = false;
    }
  }, 500);
}

// ── Chat ──────────────────────────────────────────────────────────────────────

async function openChat(dialog: TgDialog, addToHistory = false) {
  // Cancel the background dialog load so this request gets the connection first
  cancelBgDialogLoad();
  // Prefer fresh dialog data from the loaded list (has accurate unreadCount)
  const fresh = dialogs.value.find((d) => d.chatId === dialog.chatId);
  let dlg = fresh ?? dialog;

  // Channels/groups not in the subscribed dialogs list = user is not a member.
  // The Telegram API only sets `left: true` when the user explicitly left; for channels
  // never joined the flag is absent, so Boolean(c.left) returns false incorrectly.
  // Dialogs list contains only subscribed chats, so absence there is the reliable signal.
  if (
    !fresh &&
    dialogs.value.length > 0 &&
    (dlg.type === "channel" || dlg.type === "group")
  ) {
    dlg = { ...dlg, left: true };
  }

  if (addToHistory && activeChat.value && activeChat.value.chatId !== dlg.chatId) {
    chatNavStack.value.push(activeChat.value);
  } else if (!addToHistory) {
    chatNavStack.value = [];
  }
  activeChatId.value = dlg.chatId;
  activeChat.value = dlg;
  saveMessengerState();
  messages.value = [];
  firstUnreadId.value = null;
  canLoadMore.value = true;
  scrolledToBottom = true;
  jumpBtnVisible.value = false;
  jumpUnseenCount.value = 0;
  showMobileChat.value = true;
  showProfile.value = false;
  profileDetails.value = null;
  resetMembers();
  showThread.value = false;
  threadRootMsg.value = null;
  replyingTo.value = null;
  editingMsg.value = null;
  exitSelectMode();
  botCommands.value = [];
  botMenuButton.value = null;
  joinRequestSent.value = false;
  pendingJoinChatId.value = null;
  stopMembershipPoll();
  stopBotMsgWatch();
  pinnedMsg.value = null;
  webViewPanel.value = null;
  closeMsgSearch();
  await fetchMessages();
  markChatRead(dlg.chatId);
  if (dlg.type === "bot") loadBotCommands(dlg.chatId);
  loadPinnedMessage(); // fire-and-forget -- no need to block chat open
  // Resume background dialog load 2s after messages are shown -- low priority
  if (selectedAccountId.value) {
    const accountId = selectedAccountId.value;
    setTimeout(() => startBgDialogLoad(accountId), 2000);
  }
  await nextTick();
  inputEl.value?.focus();
}

function markChatRead(chatId: string) {
  if (!selectedAccountId.value || !messages.value.length) return;
  const maxId = Math.max(...messages.value.map((m) => m.id));

  // Clear badge immediately in UI
  firstUnreadId.value = null;
  const idx = dialogs.value.findIndex((d) => d.chatId === chatId);
  if (idx !== -1)
    dialogs.value[idx] = { ...dialogs.value[idx], unreadCount: 0 };

  // Coalesce into one request per chat -- same chat just bumps maxId and waits
  if (markReadPending?.chatId === chatId) {
    markReadPending.maxId = Math.max(markReadPending.maxId, maxId);
    return;
  }

  // Different chat -- flush pending immediately before starting a new timer
  if (markReadPending && markReadTimer) {
    clearTimeout(markReadTimer);
    markReadTimer = null;
    tgClientApi.markRead(selectedAccountId.value, markReadPending.chatId, markReadPending.maxId).catch(() => {});
  }

  markReadPending = { chatId, maxId };
  markReadTimer = setTimeout(() => {
    markReadTimer = null;
    if (markReadPending && selectedAccountId.value) {
      tgClientApi.markRead(selectedAccountId.value, markReadPending.chatId, markReadPending.maxId).catch(() => {});
      markReadPending = null;
    }
  }, 2000);
}

async function clearChatCache() {
  if (!selectedAccountId.value || !activeChatId.value) return;
  await tgClientApi.clearCache(selectedAccountId.value, activeChatId.value);
  await fetchMessages(true);
}

async function loadPinnedMessage() {
  if (!selectedAccountId.value || !activeChatId.value) return;
  const chat = activeChat.value;
  if (!chat || (chat.type !== 'group' && chat.type !== 'channel')) {
    pinnedMsg.value = null;
    return;
  }
  try {
    pinnedMsg.value = await tgClientApi.pinnedMessage(selectedAccountId.value, activeChatId.value);
  } catch {
    pinnedMsg.value = null;
  }
}

async function jumpToPinned() {
  if (!pinnedMsg.value) return;
  await jumpToMessage(pinnedMsg.value.id);
}

async function toggleMsgSearch() {
  if (msgSearchOpen.value) {
    closeMsgSearch();
    return;
  }
  msgSearchOpen.value = true;
  await nextTick();
  msgSearchInputEl.value?.focus();
}

function closeMsgSearch() {
  msgSearchOpen.value = false;
  msgSearchQuery.value = '';
  msgSearchResults.value = [];
  msgSearchDone.value = false;
  msgSearchLoading.value = false;
}

async function runMsgSearch() {
  const q = msgSearchQuery.value.trim();
  if (!q || !selectedAccountId.value || !activeChatId.value) return;
  msgSearchLoading.value = true;
  msgSearchDone.value = false;
  try {
    const results = await tgClientApi.searchMessages(
      selectedAccountId.value,
      activeChatId.value,
      q,
      { limit: 30 },
    );
    // Newest first, as Telegram returns them
    msgSearchResults.value = results.sort((a, b) => b.id - a.id);
    msgSearchDone.value = true;
  } catch {
    msgSearchResults.value = [];
    msgSearchDone.value = true;
  } finally {
    msgSearchLoading.value = false;
  }
}

async function openMsgSearchResult(msg: TgMessage) {
  await jumpToMessage(msg.id);
}

// Scrolls a message into view, loading context around it if it is not loaded
async function jumpToMessage(id: number) {
  if (!selectedAccountId.value || !activeChatId.value) return;
  const inView = messages.value.find((m) => m.id === id);
  if (inView) {
    await nextTick();
    const el = messagesEl.value;
    if (!el) return;
    const target = el.querySelector(`[data-msg-id="${id}"]`);
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      target.classList.add('tgc-msg-highlighted');
      setTimeout(() => target.classList.remove('tgc-msg-highlighted'), 1500);
    }
    return;
  }
  // Message not in current view -- load context around the pinned message AND
  // the recent messages so the user can still scroll down to the latest.
  const [aroundMsgs, recentMsgs] = await Promise.all([
    tgClientApi.messages(selectedAccountId.value, activeChatId.value, {
      limit: 30, offsetId: id + 1, fresh: 1,
    }),
    tgClientApi.messages(selectedAccountId.value, activeChatId.value, {
      limit: 30, fresh: 1,
    }),
  ]);

  // Merge and deduplicate, keep chronological order
  const byId = new Map<number, TgMessage>();
  for (const m of [...aroundMsgs, ...recentMsgs]) byId.set(m.id, m);
  messages.value = Array.from(byId.values()).sort((a, b) => a.id - b.id);
  canLoadMore.value = true;

  await nextTick();
  const el = messagesEl.value;
  if (!el) return;
  const target = el.querySelector(`[data-msg-id="${id}"]`);
  if (target) {
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.add('tgc-msg-highlighted');
    setTimeout(() => target.classList.remove('tgc-msg-highlighted'), 1500);
  }
}

async function backToDialogs() {
  const prev = chatNavStack.value.pop();
  if (prev) {
    const remainingStack = [...chatNavStack.value];
    // Save before openChat clears join state
    const savedPendingId = pendingJoinChatId.value;
    await openChat(prev);
    chatNavStack.value = remainingStack;
    // If navigating back to the group that has a pending join, restore the pending state
    if (savedPendingId && prev.chatId === savedPendingId) {
      joinRequestSent.value = true;
      pendingJoinChatId.value = savedPendingId;
      startMembershipPoll();
    }
  } else {
    // No nav history -- on mobile this returns to the dialog list; on desktop it's a no-op
    showMobileChat.value = false;
  }
}

function closeChat() {
  const prev = chatNavStack.value.pop();
  if (prev) {
    // Has history -- navigate back (same as Back button)
    const remainingStack = [...chatNavStack.value];
    const savedPendingId = pendingJoinChatId.value;
    openChat(prev).then(() => {
      chatNavStack.value = remainingStack;
      if (savedPendingId && prev.chatId === savedPendingId) {
        joinRequestSent.value = true;
        pendingJoinChatId.value = savedPendingId;
        startMembershipPoll();
      }
    });
  } else {
    // No history -- fully deselect the chat
    showMobileChat.value = false;
    activeChatId.value = null;
    activeChat.value = null;
    messages.value = [];
    pinnedMsg.value = null;
    stopBotMsgWatch();
    stopMembershipPoll();
  }
}

async function fetchMessages(fresh = false) {
  if (!selectedAccountId.value || !activeChatId.value) return;
  // Cancel any in-flight fetch (user switched chats before previous one finished)
  msgFetchCtrl?.abort();
  msgFetchCtrl = new AbortController();
  const ctrl = msgFetchCtrl;
  const chatId = activeChatId.value;
  const unreadCount = activeChat.value?.unreadCount ?? 0;

  loadingMessages.value = true;
  try {
    const msgs = await tgClientApi.messages(
      selectedAccountId.value,
      chatId,
      { limit: 30, ...(fresh ? { fresh: 1 } : {}) },
      ctrl.signal,
    );
    if (ctrl.signal.aborted || activeChatId.value !== chatId) return;
    messages.value = msgs.reverse();
    if (msgs.length < 30) canLoadMore.value = false;

    // Tell the backend which chat is active so it can periodically sync new messages
    if (liveWs && liveWs.readyState === WebSocket.OPEN) {
      liveWs.send(JSON.stringify({ type: "activateChat", chatId }));
    }

    // Mark the first unread message so we can scroll to it and show a divider.
    // Service notices are not unread anything, so they don't count towards the offset.
    const realMsgs = messages.value.filter((m) => !m.service);
    firstUnreadId.value =
      unreadCount > 0 && unreadCount < realMsgs.length
        ? realMsgs[realMsgs.length - unreadCount].id
        : null;
    await scrollToUnread();
    scheduleBotMsgWatch();
  } catch (e: any) {
    if (ctrl.signal.aborted) return;
    console.error("Failed to load messages:", e);
  } finally {
    // Only clear the spinner if this is still the active fetch
    if (msgFetchCtrl === ctrl) {
      loadingMessages.value = false;
      msgFetchCtrl = null;
    }
  }
}

async function loadOlderMessages() {
  if (!selectedAccountId.value || !activeChatId.value || !messages.value.length)
    return;
  loadingOlder.value = true;
  const oldestId = messages.value[0].id;
  const el = messagesEl.value;
  const prevScrollHeight = el?.scrollHeight ?? 0;
  try {
    const older = await tgClientApi.messages(
      selectedAccountId.value,
      activeChatId.value,
      {
        limit: 50,
        offsetId: oldestId,
      },
    );
    if (older.length < 50) canLoadMore.value = false;
    messages.value = [...older.reverse(), ...messages.value];
    await nextTick();
    // Preserve scroll position after prepend
    if (el) el.scrollTop = el.scrollHeight - prevScrollHeight;
  } catch (e: any) {
    console.error("Failed to load older messages:", e);
  } finally {
    loadingOlder.value = false;
  }
}

function onComposeKey(e: KeyboardEvent) {
  if (e.key === "Escape" && editingMsg.value) {
    e.preventDefault();
    cancelEditMessage();
    return;
  }
  // Command suggestion keyboard navigation
  if (commandSuggestions.value.length) {
    if (e.key === "ArrowUp") {
      e.preventDefault();
      selectedCmdIdx.value = Math.max(0, selectedCmdIdx.value - 1);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      selectedCmdIdx.value = Math.min(
        commandSuggestions.value.length - 1,
        selectedCmdIdx.value + 1,
      );
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      const idx = selectedCmdIdx.value >= 0 ? selectedCmdIdx.value : 0;
      const cmd = commandSuggestions.value[idx];
      if (cmd) selectCommand(cmd);
      return;
    }
    if (e.key === "Enter" && selectedCmdIdx.value >= 0) {
      e.preventDefault();
      selectCommand(commandSuggestions.value[selectedCmdIdx.value]);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      inputText.value = "";
      return;
    }
  }

  if (e.key === "Enter" && !e.shiftKey && !composing.value) {
    e.preventDefault();
    sendMessage();
  }
}

function triggerFilePick() {
  fileInput.value?.click();
}

function onFileSelected(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = ""; // allow re-selecting the same file later
  if (!file) return;
  if (pendingPreviewUrl.value) URL.revokeObjectURL(pendingPreviewUrl.value);
  pendingFile.value = file;
  pendingPreviewUrl.value = file.type.startsWith("image/")
    ? URL.createObjectURL(file)
    : null;
  // Non-image files default to being sent as a document.
  sendAsDocument.value = !file.type.startsWith("image/");
  nextTick(() => inputEl.value?.focus());
}

function clearPendingFile() {
  if (pendingPreviewUrl.value) URL.revokeObjectURL(pendingPreviewUrl.value);
  pendingFile.value = null;
  pendingPreviewUrl.value = null;
  sendAsDocument.value = false;
}

// Attach an image pasted from the clipboard (e.g. a screenshot).
function onPaste(e: ClipboardEvent) {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
    const blob = item.getAsFile();
    if (!blob) continue;
    e.preventDefault();
    const ext = item.type.split("/")[1] || "png";
    const file = new File([blob], `pasted-image.${ext}`, { type: item.type });
    if (pendingPreviewUrl.value) URL.revokeObjectURL(pendingPreviewUrl.value);
    pendingFile.value = file;
    pendingPreviewUrl.value = URL.createObjectURL(file);
    sendAsDocument.value = false;
    return;
  }
}

async function sendFileMessage() {
  const file = pendingFile.value;
  if (!file || !selectedAccountId.value || !activeChatId.value || sending.value)
    return;
  sending.value = true;
  const caption = inputText.value.trim();
  const replyMsg = replyingTo.value;
  const asDocument = sendAsDocument.value;
  inputText.value = "";
  replyingTo.value = null;
  clearPendingFile();
  if (inputEl.value) inputEl.value.style.height = "auto";
  try {
    const result = await tgClientApi.sendFile(
      selectedAccountId.value,
      activeChatId.value,
      file,
      { caption: caption || undefined, asDocument, replyToMsgId: replyMsg?.id },
    );
    messages.value.push({
      id: result.id,
      text: caption,
      html: null,
      date: result.date,
      fromMe: true,
      isRead: false,
      fromId: null,
      fromName: null,
      hasPhoto: result.hasPhoto,
      hasDocument: result.hasDocument,
      hasSticker: false,
      fileName: result.hasDocument ? file.name : null,
      buttons: null,
      reactions: null,
      replyToId: replyMsg?.id ?? null,
      replyToText: replyMsg?.text ?? null,
      replyToName: null,
      replyCount: null,
    });
    await scrollBottom(true);
    const idx = dialogs.value.findIndex((d) => d.chatId === activeChatId.value);
    if (idx !== -1) {
      dialogs.value[idx] = {
        ...dialogs.value[idx],
        lastMessage: {
          text: caption || (asDocument ? "File" : "Photo"),
          date: result.date,
          fromMe: true,
        },
      };
      const [moved] = dialogs.value.splice(idx, 1);
      dialogs.value.unshift(moved);
    }
  } catch (e: any) {
    console.error("Send file failed:", e);
  } finally {
    sending.value = false;
    await nextTick();
    inputEl.value?.focus();
  }
}

async function sendMessage() {
  if (editingMsg.value) {
    await submitEditMessage();
    return;
  }
  if (pendingFile.value) {
    await sendFileMessage();
    return;
  }
  const text = inputText.value.trim();
  if (!text || !selectedAccountId.value || !activeChatId.value || sending.value)
    return;
  sending.value = true;
  const replyMsg = replyingTo.value;
  inputText.value = "";
  replyingTo.value = null;
  if (inputEl.value) {
    inputEl.value.style.height = "auto";
  }
  try {
    const result = await tgClientApi.send(
      selectedAccountId.value,
      activeChatId.value,
      text,
      replyMsg?.id,
    );
    // Optimistically append
    messages.value.push({
      id: result.id,
      text,
      html: null,
      date: result.date,
      fromMe: true,
      isRead: false,
      fromId: null,
      fromName: null,
      hasPhoto: false,
      hasDocument: false,
      hasSticker: false,
      fileName: null,
      buttons: null,
      reactions: null,
      replyToId: replyMsg?.id ?? null,
      replyToText: replyMsg?.text ?? null,
      replyToName: null,
      replyCount: null,
    });
    await scrollBottom(true);
    // Update dialog preview
    const idx = dialogs.value.findIndex((d) => d.chatId === activeChatId.value);
    if (idx !== -1) {
      dialogs.value[idx] = {
        ...dialogs.value[idx],
        lastMessage: { text, date: result.date, fromMe: true },
      };
      // Sort dialog to top
      const [moved] = dialogs.value.splice(idx, 1);
      dialogs.value.unshift(moved);
    }
  } catch (e: any) {
    console.error("Send failed:", e);
  } finally {
    sending.value = false;
    await nextTick();
    inputEl.value?.focus();
  }
}

// ── WebSocket live connection ─────────────────────────────────────────────────

function closeLiveSocket() {
  if (wsReconnectTimer) {
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = null;
  }
  liveWs?.close();
  liveWs = null;
  wsAccountId = null;
  wsEverOpen = false;
  wsBackoff = 1_000;
}

function startLiveSocket() {
  if (!selectedAccountId.value) return;
  // Cancel any pending reconnect before starting a fresh connection
  if (wsReconnectTimer) {
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = null;
  }
  liveWs?.close();

  const accountId = selectedAccountId.value;
  wsAccountId = accountId;
  const token = localStorage.getItem("token") ?? "";
  const proto = location.protocol === "https:" ? "wss" : "ws";
  // accountId in the URL is non-sensitive; token is sent as the first message so it never appears in access logs
  const ws = new WebSocket(
    `${proto}://${location.host}/ws?accountId=${accountId}`,
  );
  liveWs = ws;

  ws.onopen = () => {
    wsBackoff = 1_000;
    ws.send(JSON.stringify({ type: "auth", token }));
  };

  ws.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data as string);
      if (data.type === "authenticated") {
        // Auth handshake complete -- resume normal operation
        if (wsEverOpen) {
          catchUpActiveChatMessages();
        }
        wsEverOpen = true;
        if (activeChatId.value) {
          ws.send(JSON.stringify({ type: "activateChat", chatId: activeChatId.value }));
        }
      } else if (data.type === "message") {
        onIncomingMessage(data.chatId as string, data.message as TgMessage);
      } else if (data.type === "dialogs" && Array.isArray(data.dialogs)) {
        dialogs.value = data.dialogs as TgDialog[];
      } else if (data.type === "readOutbox") {
        onReadOutbox(data.chatId as string, data.maxId as number);
      } else if (data.type === "typing") {
        onTypingEvent(
          data.chatId as string,
          (data.userName as string | null) ?? null,
          Boolean(data.cancelled),
        );
      }
    } catch {
      /* ignore parse errors */
    }
  };

  ws.onclose = () => {
    if (wsAccountId !== accountId) return; // account changed -- don't reconnect
    // Exponential backoff reconnect, capped at 30 s
    wsReconnectTimer = setTimeout(() => {
      wsBackoff = Math.min(wsBackoff * 2, 30_000);
      startLiveSocket();
    }, wsBackoff);
  };

  ws.onerror = () => {
    // onclose fires right after -- reconnect logic lives there
  };
}

// On reconnect, silently append any messages that arrived while the socket was down.
async function catchUpActiveChatMessages(): Promise<void> {
  if (!selectedAccountId.value || !activeChatId.value || !messages.value.length)
    return;
  const newestId = Math.max(...messages.value.map((m) => m.id));
  try {
    const fresh = await tgClientApi.messages(
      selectedAccountId.value,
      activeChatId.value,
      { limit: 50 },
    );
    const newMsgs = fresh.filter((m) => m.id > newestId).reverse(); // oldest-first
    for (const msg of newMsgs) {
      if (!messages.value.find((m) => m.id === msg.id))
        messages.value.push(msg);
    }
    if (newMsgs.length) await scrollBottom(true);
  } catch {
    // Best effort -- non-critical
  }
}

function onIncomingMessage(chatId: string, msg: TgMessage) {
  // Update dialog preview. A service notice carries no text of its own, so it neither
  // previews nor counts as unread -- the chat keeps the last thing someone actually said.
  const idx = msg.service ? -1 : dialogs.value.findIndex((d) => d.chatId === chatId);
  if (idx !== -1) {
    const updated = {
      ...dialogs.value[idx],
      lastMessage: { text: msg.text, date: msg.date, fromMe: false },
    };
    if (!msg.fromMe && chatId !== activeChatId.value)
      updated.unreadCount = (updated.unreadCount ?? 0) + 1;
    dialogs.value.splice(idx, 1);
    dialogs.value.unshift(updated);
  }

  // Append to open chat
  if (chatId === activeChatId.value) {
    // Avoid duplicate if already optimistically appended
    if (!messages.value.find((m) => m.id === msg.id)) {
      messages.value.push(msg);
      if (!scrolledToBottom && !msg.fromMe && !msg.service)
        jumpUnseenCount.value++;
      scrollBottom();
    }
    if (msg.service) return;
    // Mark as read on TG server and clear local badge
    markChatRead(chatId);
    // If a bot sent this message it may keep editing it -- start the watcher
    if (!msg.fromMe) scheduleBotMsgWatch();
  }
}

// Mark outgoing messages as read when the backend reports the recipient read them
function onReadOutbox(chatId: string, maxId: number) {
  if (chatId !== activeChatId.value) return;
  for (const msg of messages.value) {
    if (msg.fromMe && !msg.isRead && msg.id <= maxId) {
      msg.isRead = true;
    }
  }
}

// ── Contacts ──────────────────────────────────────────────────────────────────

async function loadContacts() {
  if (!selectedAccountId.value) return;
  loadingContacts.value = true;
  try {
    contacts.value = await tgClientApi.contacts(selectedAccountId.value);
  } catch (e: any) {
    console.error("Failed to load contacts:", e);
  } finally {
    loadingContacts.value = false;
  }
}

function openContactChat(c: TgContact) {
  showContacts.value = false;
  const existing = dialogs.value.find((d) => d.chatId === c.chatId);
  if (existing) {
    openChat(existing);
  } else {
    // Create a synthetic dialog entry for this contact
    const synthetic: TgDialog = {
      chatId: c.chatId,
      name:
        [c.firstName, c.lastName].filter(Boolean).join(" ") ||
        c.username ||
        c.phone ||
        "Unknown",
      type: "user",
      username: c.username,
      unreadCount: 0,
      lastMessage: null,
    };
    dialogs.value.unshift(synthetic);
    openChat(synthetic);
  }
}

async function addContactSubmit() {
  if (!selectedAccountId.value) return;
  addContactError.value = "";
  addContactOk.value = false;
  addingContact.value = true;
  try {
    const c = await tgClientApi.addContact(
      selectedAccountId.value,
      newPhone.value.trim(),
      newFirstName.value.trim(),
    );
    contacts.value.unshift(c);
    newPhone.value = "";
    newFirstName.value = "";
    addContactOk.value = true;
    setTimeout(() => {
      addContactOk.value = false;
    }, 3000);
  } catch (e: any) {
    addContactError.value =
      e?.response?.data?.error ?? e.message ?? "Failed to add contact";
  } finally {
    addingContact.value = false;
  }
}

function startEditContact() {
  if (!profileDetails.value) return;
  editFirstName.value = profileDetails.value.firstName ?? profileDetails.value.name.split(" ")[0] ?? "";
  editLastName.value = profileDetails.value.lastName ?? profileDetails.value.name.split(" ").slice(1).join(" ") ?? "";
  saveContactError.value = "";
  editingContact.value = true;
}

async function saveContactEdit() {
  if (!selectedAccountId.value || !profileDetails.value) return;
  saveContactError.value = "";
  savingContact.value = true;
  try {
    const contact = await tgClientApi.editContact(
      selectedAccountId.value,
      profileDetails.value.chatId,
      editFirstName.value.trim(),
      editLastName.value.trim(),
    );
    // Update local state
    profileDetails.value.firstName = contact.firstName;
    profileDetails.value.lastName = contact.lastName;
    profileDetails.value.name = [contact.firstName, contact.lastName].filter(Boolean).join(" ") || profileDetails.value.name;
    const dialog = dialogs.value.find((d) => d.chatId === profileDetails.value!.chatId);
    if (dialog) dialog.name = profileDetails.value.name;
    editingContact.value = false;
  } catch (e: any) {
    saveContactError.value = e?.response?.data?.error ?? e.message ?? "Failed to save";
  } finally {
    savingContact.value = false;
  }
}
</script>

<style scoped>
/* ── Full-page layout ───────────────────────────────────────────────────────── */
.tgc-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.tgc-popup-inline {
  height: 100% !important;
  max-height: none !important;
  border-radius: 0 !important;
  box-shadow: none !important;
  width: 100% !important;
}

.tgc-popup {
  background: #fff;
  border-radius: 10px;
  width: 100%;
  max-width: none;
  height: calc(100vh - 32px);
  max-height: none;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.2);
  position: relative;
}

/* ── Header ─────────────────────────────────────────────────────────────────── */
.tgc-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  border-bottom: 1px solid #e8e9ed;
  flex-shrink: 0;
  gap: 10px;
  background: #fff;
}

.tgc-header-left {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.tgc-header-right {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.tgc-logo {
  color: #4361ee;
  flex-shrink: 0;
}

.tgc-title {
  font-weight: 600;
  font-size: 15px;
  white-space: nowrap;
  color: #1a1a2e;
}

.tgc-account-select {
  background: #f5f6fa;
  border: 1px solid #e0e0e8;
  color: #1a1a2e;
  border-radius: 6px;
  padding: 3px 8px;
  font-size: 13px;
  max-width: 180px;
  cursor: pointer;
  outline: none;
}

.tgc-icon-btn {
  background: none;
  border: none;
  color: #888;
  cursor: pointer;
  padding: 6px 8px;
  border-radius: 6px;
  font-size: 15px;
  transition:
    background 0.15s,
    color 0.15s;
}

.tgc-icon-btn:hover {
  background: #f0f2f5;
  color: #1a1a2e;
}

.tgc-icon-btn--active {
  color: #4361ee;
  background: #eef0fd;
}

/* ── Body ───────────────────────────────────────────────────────────────────── */
.tgc-body {
  display: flex;
  flex: 1;
  overflow: hidden;
  background: #fff;
}

/* ── Sidebar ────────────────────────────────────────────────────────────────── */
.tgc-sidebar {
  width: 290px;
  flex-shrink: 0;
  border-right: 1px solid #e8e9ed;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: #f8f9fb;
}

.tgc-search-wrap {
  position: relative;
  padding: 10px 12px 8px;
  flex-shrink: 0;
  background: #f8f9fb;
}

.tgc-search-icon {
  position: absolute;
  left: 22px;
  top: 50%;
  transform: translateY(-50%);
  color: #aaa;
  font-size: 12px;
  pointer-events: none;
}

.tgc-search-input {
  width: 100%;
  background: #fff;
  border: 1px solid #dde0e8;
  border-radius: 20px;
  padding: 6px 28px 6px 30px;
  font-size: 13px;
  color: #1a1a2e;
  outline: none;
  box-sizing: border-box;
  transition: border-color 0.15s;
}

.tgc-search-input:focus {
  border-color: #4361ee;
}

.tgc-search-clear {
  position: absolute;
  right: 22px;
  top: 50%;
  transform: translateY(-50%);
  background: none;
  border: none;
  color: #aaa;
  cursor: pointer;
  padding: 2px;
  font-size: 12px;
}

/* ── Folder tabs ────────────────────────────────────────────────────────────── */
.tgc-folder-tabs-wrap {
  position: relative;
  flex-shrink: 0;
}

/* Fade-out on the right to hint at hidden tabs */
.tgc-folder-tabs-wrap::after {
  content: "";
  position: absolute;
  top: 0;
  right: 0;
  bottom: 8px;
  width: 24px;
  background: linear-gradient(to right, transparent, #f8f9fb);
  pointer-events: none;
}

.tgc-folder-tabs {
  display: flex;
  gap: 6px;
  padding: 0 12px 8px;
  overflow-x: auto;
  scrollbar-width: thin;
  scrollbar-color: #dde0e8 transparent;
  flex-shrink: 0;
}

.tgc-folder-tabs::-webkit-scrollbar {
  height: 3px;
}

.tgc-folder-tabs::-webkit-scrollbar-thumb {
  background: #dde0e8;
  border-radius: 2px;
}

.tgc-folder-tab {
  background: none;
  border: 1px solid #dde0e8;
  border-radius: 16px;
  padding: 3px 12px;
  font-size: 12px;
  color: #666;
  cursor: pointer;
  white-space: nowrap;
  flex-shrink: 0;
  transition:
    background 0.15s,
    color 0.15s,
    border-color 0.15s;
}

.tgc-folder-tab:hover {
  background: #eef0f6;
}

.tgc-folder-tab.active {
  background: #4361ee;
  border-color: #4361ee;
  color: #fff;
  font-weight: 500;
}

.tgc-dialog-list {
  flex: 1;
  overflow-y: auto;
  scrollbar-width: thin;
}

.tgc-dialog-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  cursor: pointer;
  transition: background 0.1s;
  min-height: 60px;
}

.tgc-dialog-item:hover {
  background: #eef0f6;
}

.tgc-dialog-item.active {
  background: #dce3ff;
}

.tgc-dialog-info {
  flex: 1;
  min-width: 0;
}

.tgc-dialog-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 4px;
}

.tgc-dialog-name {
  font-size: 14px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: #1a1a2e;
  flex: 1;
  min-width: 0;
}

.tgc-dialog-time {
  font-size: 11px;
  color: #999;
  flex-shrink: 0;
}

.tgc-dialog-preview {
  font-size: 12px;
  color: #999;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
  min-width: 0;
}

.tgc-dialog-username {
  color: #4361ee;
}

.tgc-unread-badge {
  background: #4361ee;
  color: #fff;
  font-size: 11px;
  font-weight: 600;
  border-radius: 10px;
  padding: 1px 6px;
  flex-shrink: 0;
}

/* ── Avatar ─────────────────────────────────────────────────────────────────── */
.tgc-avatar {
  width: 42px;
  height: 42px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 17px;
  font-weight: 600;
  flex-shrink: 0;
  color: #fff;
}

.tgc-avatar-sm {
  width: 34px;
  height: 34px;
  font-size: 14px;
}

.tgc-avatar-user {
  background: #4a90e2;
}
.tgc-avatar-bot {
  background: #7c4dff;
}
.tgc-avatar-group {
  background: #26a69a;
}
.tgc-avatar-channel {
  background: #ef6c00;
}

/* ── Chat panel ─────────────────────────────────────────────────────────────── */
.tgc-chat {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: #fff;
  position: relative;
}

.tgc-chat-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  border-bottom: 1px solid #e8e9ed;
  flex-shrink: 0;
  background: #fff;
}

.tgc-chat-title-wrap {
  min-width: 0;
  flex: 1;
}

.tgc-chat-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}

/* Collapsed actions menu button -- mobile only */
.tgc-chat-menu-btn {
  display: none;
  flex-shrink: 0;
}

.tgc-chat-name {
  font-size: 15px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: #1a1a2e;
}

.tgc-chat-sub {
  font-size: 12px;
  color: #999;
}

/* ── In-chat message search ─────────────────────────────────────────────────── */
.tgc-msg-search {
  background: #f0f4ff;
  border-bottom: 1px solid #dce3f5;
  flex-shrink: 0;
}
.tgc-msg-search-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
}
.tgc-msg-search-icon {
  color: #5c7cfa;
  font-size: 13px;
  flex-shrink: 0;
}
.tgc-msg-search-input {
  flex: 1;
  min-width: 0;
  border: 1px solid #dce3f5;
  border-radius: 8px;
  padding: 6px 10px;
  font-size: 13px;
  background: #fff;
  outline: none;
}
.tgc-msg-search-input:focus {
  border-color: #5c7cfa;
}
.tgc-msg-search-empty {
  padding: 10px 16px;
  font-size: 13px;
  color: #888;
}
.tgc-msg-search-results {
  max-height: 240px;
  overflow-y: auto;
  scrollbar-width: thin;
  border-top: 1px solid #dce3f5;
}
.tgc-msg-search-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 7px 16px;
  cursor: pointer;
  transition: background 0.15s;
}
.tgc-msg-search-row:hover {
  background: #e4ecff;
}
.tgc-msg-search-from {
  font-size: 12px;
  font-weight: 600;
  color: #5c7cfa;
  flex-shrink: 0;
  max-width: 130px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tgc-msg-search-text {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  color: #444;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tgc-msg-search-date {
  font-size: 11px;
  color: #999;
  flex-shrink: 0;
}

.tgc-pinned-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 16px;
  background: #f0f4ff;
  border-bottom: 1px solid #dce3f5;
  cursor: pointer;
  flex-shrink: 0;
  transition: background 0.15s;
}
.tgc-pinned-bar:hover {
  background: #e4ecff;
}
.tgc-pinned-icon {
  color: #5c7cfa;
  font-size: 13px;
  flex-shrink: 0;
  transform: rotate(45deg);
}
.tgc-pinned-content {
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.tgc-pinned-label {
  font-size: 11px;
  font-weight: 600;
  color: #5c7cfa;
  line-height: 1.2;
}
.tgc-pinned-text {
  font-size: 13px;
  color: #444;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tgc-messages {
  flex: 1;
  overflow-y: auto;
  padding: 16px 20px;
  scrollbar-width: thin;
  display: flex;
  flex-direction: column;
  gap: 2px;
  background: #f5f7fb;
}

/* ── Jump-to-latest floating button ─────────────────────────────────────────
   Zero-height sticky anchor as the last child of the scroller, so the button
   pins to the bottom-right of the visible message area without taking space */
.tgc-jump-anchor {
  position: sticky;
  bottom: 8px;
  height: 0;
  align-self: flex-end;
  z-index: 5;
}

.tgc-jump-btn {
  position: absolute;
  right: 0;
  bottom: 0;
  width: 42px;
  height: 42px;
  border-radius: 50%;
  background: #fff;
  border: 1px solid #e8e9ed;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.18);
  color: #555;
  font-size: 15px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition:
    background 0.15s,
    color 0.15s;
}

.tgc-jump-btn:hover {
  background: #f0f2f5;
  color: #1a1a2e;
}

.tgc-jump-badge {
  position: absolute;
  top: -7px;
  left: 50%;
  transform: translateX(-50%);
  background: #4361ee;
  color: #fff;
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
  padding: 3px 6px;
  border-radius: 10px;
  min-width: 18px;
  text-align: center;
}

/* ── Messages ───────────────────────────────────────────────────────────────── */
.tgc-date-sep {
  text-align: center;
  font-size: 12px;
  color: #999;
  margin: 12px 0 6px;
  position: relative;
}

.tgc-date-sep::before,
.tgc-date-sep::after {
  content: "";
  position: absolute;
  top: 50%;
  width: calc(50% - 70px);
  height: 1px;
  background: #dde0e8;
}

.tgc-date-sep::before {
  left: 0;
}
.tgc-date-sep::after {
  right: 0;
}

/* Service notices: joined / left / renamed, centred and unobtrusive */
.tgc-service-msg {
  display: flex;
  justify-content: center;
  margin: 6px 0;
}

.tgc-service-msg span {
  max-width: 80%;
  padding: 3px 10px;
  border-radius: 12px;
  background: rgba(0, 0, 0, 0.05);
  color: #888;
  font-size: 12px;
  line-height: 1.4;
  text-align: center;
  word-break: break-word;
}

.tgc-unread-sep {
  text-align: center;
  font-size: 12px;
  color: #4a9eff;
  margin: 12px 0 6px;
  position: relative;
}
.tgc-unread-sep::before,
.tgc-unread-sep::after {
  content: "";
  position: absolute;
  top: 50%;
  width: calc(50% - 72px);
  height: 1px;
  background: #4a9eff66;
}
.tgc-unread-sep::before {
  left: 0;
}
.tgc-unread-sep::after {
  right: 0;
}

.tgc-msg-wrap {
  display: flex;
  margin: 2px 0;
}

.tgc-msg-in {
  justify-content: flex-start;
}

.tgc-sender-av,
.tgc-sender-av-ph {
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  margin-right: 6px;
  align-self: flex-end;
  order: -1;
}

.tgc-sender-av {
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: 700;
  color: #fff;
  user-select: none;
  overflow: hidden;
}

.tgc-sender-av-photo {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: 50%;
}

.tgc-msg-out {
  justify-content: flex-end;
}

.tgc-msg-bubble {
  max-width: 68%;
  min-width: 80px;
  padding: 7px 10px 5px;
  border-radius: 12px;
  font-size: 14px;
  line-height: 1.5;
  word-break: break-word;
}

.tgc-msg-in .tgc-msg-bubble {
  background: #fff;
  border: 1px solid #e8e9ed;
  border-bottom-left-radius: 4px;
  color: #1a1a2e;
}

.tgc-msg-out .tgc-msg-bubble {
  background: #4361ee;
  border-bottom-right-radius: 4px;
  color: #fff;
}

.tgc-msg-sender {
  font-size: 12px;
  font-weight: 600;
  color: #4361ee;
  margin-bottom: 2px;
}

.tgc-msg-out .tgc-msg-sender {
  color: rgba(255, 255, 255, 0.85);
}

.tgc-msg-text {
  white-space: pre-wrap;
}

.tgc-link {
  color: #4a9eff;
  text-decoration: underline;
  cursor: pointer;
  word-break: break-all;
}

.tgc-msg-doc {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  max-width: 240px;
  padding: 8px 12px;
  margin-bottom: 4px;
  background: rgba(67, 97, 238, 0.08);
  border-radius: 8px;
  color: #4361ee;
  font-size: 13px;
  text-decoration: none;
  cursor: pointer;
}

.tgc-msg-doc:hover {
  background: rgba(67, 97, 238, 0.16);
}

/* Outgoing bubbles are solid blue -- use white so the file chip stays visible */
.tgc-msg-out .tgc-msg-doc {
  background: rgba(255, 255, 255, 0.15);
  color: #fff;
}

.tgc-msg-out .tgc-msg-doc:hover {
  background: rgba(255, 255, 255, 0.25);
}

.tgc-msg-doc-icon {
  font-size: 16px;
  flex-shrink: 0;
}

.tgc-msg-doc-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tgc-msg-photo {
  max-width: 260px;
  max-height: 300px;
  border-radius: 8px;
  display: block;
  margin-bottom: 4px;
  cursor: pointer;
}

.tgc-msg-sticker {
  width: 120px;
  height: 120px;
  object-fit: contain;
  display: block;
  margin-bottom: 4px;
}

.tgc-msg-meta {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 3px;
  margin-top: 3px;
}

.tgc-msg-time {
  font-size: 11px;
  color: #bbb;
}

.tgc-msg-out .tgc-msg-time {
  color: rgba(255, 255, 255, 0.65);
}

.tgc-msg-tick {
  font-size: 10px;
  color: rgba(255, 255, 255, 0.65);
}

.tgc-msg-buttons {
  margin-top: 6px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.tgc-btn-row {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.tgc-btn-chip {
  background: rgba(255, 255, 255, 0.18);
  border-radius: 12px;
  padding: 4px 12px;
  font-size: 12px;
  cursor: pointer;
  border: 1px solid rgba(255, 255, 255, 0.35);
  color: inherit;
  transition:
    background 0.15s,
    opacity 0.15s;
}

.tgc-btn-chip:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.3);
}

.tgc-btn-chip:disabled {
  opacity: 0.55;
  cursor: default;
}

.tgc-btn-chip.tgc-btn-loading {
  opacity: 0.6;
  cursor: wait;
}

.tgc-msg-in .tgc-btn-chip {
  background: #eef1fb;
  border-color: #d0d4e8;
  color: #4361ee;
}

.tgc-msg-in .tgc-btn-chip:hover:not(:disabled) {
  background: #e0e4f7;
}

/* ── Message hover actions ──────────────────────────────────────────────────── */
.tgc-msg-wrap {
  position: relative;
  align-items: center;
}

.tgc-msg-actions {
  display: none;
  align-items: center;
  gap: 1px;
  flex-shrink: 0;
}

.tgc-msg-wrap:hover .tgc-msg-actions {
  display: flex;
}

.tgc-msg-in .tgc-msg-actions {
  order: 2;
  margin-left: 4px;
}

.tgc-msg-out .tgc-msg-actions {
  order: 0;
  margin-right: 4px;
}

.tgc-msg-action {
  background: #fff;
  border: 1px solid #e8e9ed;
  border-radius: 50%;
  width: 26px;
  height: 26px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  color: #888;
  cursor: pointer;
  transition:
    background 0.1s,
    color 0.1s;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.1);
}

.tgc-msg-action:hover {
  background: #f0f2f5;
  color: #4361ee;
}

/* ── Reply quote in bubble ──────────────────────────────────────────────────── */
.tgc-reply-quote {
  display: flex;
  gap: 6px;
  border-radius: 6px;
  padding: 4px 6px;
  margin-bottom: 4px;
  cursor: pointer;
  background: rgba(0, 0, 0, 0.05);
  max-width: 100%;
  overflow: hidden;
  transition: background 0.1s;
}

.tgc-reply-quote:hover {
  background: rgba(0, 0, 0, 0.09);
}

.tgc-reply-bar {
  width: 3px;
  border-radius: 2px;
  background: #4361ee;
  flex-shrink: 0;
}

.tgc-msg-out .tgc-reply-bar {
  background: rgba(255, 255, 255, 0.7);
}

.tgc-reply-content {
  min-width: 0;
}

.tgc-reply-name {
  font-size: 11px;
  font-weight: 600;
  color: #4361ee;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tgc-msg-out .tgc-reply-name {
  color: rgba(255, 255, 255, 0.85);
}

.tgc-reply-text {
  font-size: 12px;
  color: #666;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tgc-msg-out .tgc-reply-text {
  color: rgba(255, 255, 255, 0.7);
}

/* ── Reactions ──────────────────────────────────────────────────────────────── */
.tgc-reactions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 4px;
}

.tgc-reaction {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  background: #f0f2f5;
  border: 1px solid #e0e3ea;
  border-radius: 12px;
  padding: 2px 7px;
  font-size: 14px;
  cursor: pointer;
  transition:
    background 0.1s,
    border-color 0.1s;
  line-height: 1;
}

.tgc-reaction:hover {
  background: #e4e8f5;
  border-color: #c4cbdf;
}

.tgc-reaction-mine {
  background: #dce3ff;
  border-color: #4361ee;
}

.tgc-msg-out .tgc-reaction {
  background: rgba(255, 255, 255, 0.18);
  border-color: rgba(255, 255, 255, 0.35);
  color: #fff;
}

.tgc-msg-out .tgc-reaction-mine {
  background: rgba(255, 255, 255, 0.35);
}

.tgc-reaction-count {
  font-size: 11px;
  font-weight: 600;
}

/* ── Comment count button ───────────────────────────────────────────────────── */
.tgc-comment-btn {
  background: none;
  border: none;
  color: #999;
  font-size: 11px;
  cursor: pointer;
  padding: 0;
  display: flex;
  align-items: center;
  gap: 3px;
  margin-right: auto;
  transition: color 0.1s;
}

.tgc-comment-btn:hover {
  color: #4361ee;
}

.tgc-msg-out .tgc-comment-btn {
  color: rgba(255, 255, 255, 0.65);
}

/* ── Highlight flash (scroll-to-reply) ──────────────────────────────────────── */
.tgc-msg-highlighted .tgc-msg-bubble {
  animation: tgc-highlight 1.5s ease;
}

@keyframes tgc-highlight {
  0%,
  15% {
    box-shadow: 0 0 0 3px rgba(67, 97, 238, 0.4);
  }
  100% {
    box-shadow: none;
  }
}

/* ── Emoji picker ───────────────────────────────────────────────────────────── */
.tgc-emoji-picker {
  position: fixed;
  display: flex;
  gap: 2px;
  background: #fff;
  border: 1px solid #e8e9ed;
  border-radius: 28px;
  padding: 6px 8px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
  z-index: 61;
}

.tgc-emoji-btn {
  font-size: 22px;
  background: none;
  border: none;
  cursor: pointer;
  padding: 3px 5px;
  border-radius: 8px;
  line-height: 1;
  transition:
    background 0.1s,
    transform 0.1s;
}

.tgc-emoji-btn:hover {
  background: #f0f2f5;
  transform: scale(1.25);
}

/* ── Bot command suggestions ────────────────────────────────────────────────── */
.tgc-cmd-suggestions {
  border-top: 1px solid #e8e9ed;
  max-height: 220px;
  overflow-y: auto;
  background: #fff;
  flex-shrink: 0;
  scrollbar-width: thin;
}

.tgc-cmd-item {
  display: flex;
  align-items: baseline;
  gap: 12px;
  padding: 9px 16px;
  cursor: pointer;
  transition: background 0.1s;
}

.tgc-cmd-item:hover,
.tgc-cmd-selected {
  background: #f0f3ff;
}

.tgc-cmd-name {
  font-size: 14px;
  font-weight: 600;
  color: #4361ee;
  flex-shrink: 0;
}

.tgc-cmd-desc {
  font-size: 13px;
  color: #888;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
  min-width: 0;
}

/* Slash button in compose row */
.tgc-slash-btn {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  background: #f5f6fa;
  border: 1px solid #dde0e8;
  color: #4361ee;
  font-size: 16px;
  font-weight: 700;
  cursor: pointer;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  transition:
    background 0.15s,
    border-color 0.15s;
  line-height: 1;
  font-family: monospace;
}

.tgc-slash-btn:hover,
.tgc-slash-btn.active {
  background: #eef1fb;
  border-color: #4361ee;
}

/* Attach (paperclip) button */
/* The bot's pinned Mini App, first in the composer row. Given the app's own name rather
   than an icon alone: it is the one control here that leaves the chat. */
.tgc-menu-app-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  flex: none;
  /* The row is bottom-aligned and every other control in it is 34px square, so anything
     shorter sits low against them rather than reading as part of the same row. */
  height: 34px;
  box-sizing: border-box;
  max-width: 160px;
  padding: 0 12px;
  border: none;
  border-radius: 17px;
  background: #4a9eff;
  color: #fff;
  font-size: 13px;
  font-weight: 500;
  line-height: 1;
  cursor: pointer;
  transition: background 0.15s;
}

.tgc-menu-app-btn:hover {
  background: #3d8ae0;
}

.tgc-menu-app-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tgc-attach-btn {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  background: #f5f6fa;
  border: 1px solid #dde0e8;
  color: #4361ee;
  font-size: 15px;
  cursor: pointer;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  transition:
    background 0.15s,
    border-color 0.15s;
}

.tgc-attach-btn:hover {
  background: #eef1fb;
  border-color: #4361ee;
}

/* Pending attachment strip */
.tgc-attach-strip {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  background: #f8f9fb;
  border-bottom: 1px solid #e8e9ed;
}

.tgc-attach-thumb {
  width: 40px;
  height: 40px;
  object-fit: cover;
  border-radius: 6px;
  flex-shrink: 0;
}

.tgc-attach-icon {
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #eef1fb;
  border-radius: 6px;
  color: #4361ee;
  font-size: 18px;
  flex-shrink: 0;
}

.tgc-attach-info {
  flex: 1;
  min-width: 0;
}

.tgc-attach-name {
  font-size: 13px;
  color: #1a1a2e;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tgc-attach-asdoc {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: #6b7280;
  cursor: pointer;
  margin-top: 2px;
}

/* ── Image lightbox ─────────────────────────────────────────────────────────── */
.tgc-lightbox {
  position: fixed;
  inset: 0;
  z-index: 3000;
  background: rgba(0, 0, 0, 0.85);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  cursor: zoom-out;
}

.tgc-lightbox-img {
  max-width: 95vw;
  max-height: 95vh;
  object-fit: contain;
  border-radius: 6px;
  cursor: default;
}

.tgc-lightbox-close {
  position: absolute;
  top: 16px;
  right: 16px;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  border: none;
  background: rgba(255, 255, 255, 0.15);
  color: #fff;
  font-size: 20px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}

.tgc-lightbox-close:hover {
  background: rgba(255, 255, 255, 0.3);
}

/* ── Reply compose strip ────────────────────────────────────────────────────── */
.tgc-reply-strip {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  background: #f8f9fb;
  border-bottom: 1px solid #e8e9ed;
  border-radius: 0;
}

.tgc-reply-strip-icon {
  color: #4361ee;
  font-size: 13px;
  flex-shrink: 0;
}

.tgc-reply-strip-body {
  flex: 1;
  min-width: 0;
}

.tgc-reply-strip-name {
  font-size: 12px;
  font-weight: 600;
  color: #4361ee;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tgc-reply-strip-text {
  font-size: 12px;
  color: #888;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ── Compose ────────────────────────────────────────────────────────────────── */
.tgc-join-pending {
  color: #555;
  font-size: 13px;
  display: flex;
  align-items: flex-start;
  gap: 8px;
  flex: 1;
}

.tgc-join-pending i {
  color: #f4a261;
  margin-top: 2px;
  flex-shrink: 0;
}

.tgc-join-check-btn {
  background: none;
  border: 1px solid #4361ee;
  color: #4361ee;
  border-radius: 6px;
  padding: 6px 12px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  flex-shrink: 0;
}

.tgc-join-check-btn:hover {
  background: #eef0fd;
}

/* ── Mini App overlay ───────────────────────────────────────────────────────── */
.tgc-webview-overlay {
  position: absolute;
  inset: 0;
  z-index: 50;
  display: flex;
  flex-direction: column;
  background: #fff;
}

.tgc-webview-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid #e8e9ed;
  background: #fff;
  flex-shrink: 0;
}

.tgc-webview-title {
  font-size: 14px;
  font-weight: 600;
  color: #1a1a2e;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tgc-webview-frame {
  flex: 1;
  border: none;
  width: 100%;
}

.tgc-join-bar {
  border-top: 1px solid #e8e9ed;
  flex-shrink: 0;
  background: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 12px 16px;
}
.tgc-join-btn {
  background: #4361ee;
  color: #fff;
  border: none;
  border-radius: 8px;
  padding: 10px 32px;
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  justify-content: center;
}
.tgc-join-btn:disabled {
  opacity: 0.6;
  cursor: default;
}
.tgc-join-btn:not(:disabled):hover {
  background: #3251d3;
}
.tgc-spinner-sm {
  width: 14px;
  height: 14px;
  border-width: 2px;
}

.tgc-compose {
  display: flex;
  flex-direction: column;
  border-top: 1px solid #e8e9ed;
  flex-shrink: 0;
  background: #fff;
}

.tgc-compose-row {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 10px 16px;
}

.tgc-input {
  flex: 1;
  background: #f5f6fa;
  border: 1px solid #dde0e8;
  border-radius: 20px;
  padding: 8px 14px;
  font-size: 14px;
  color: #1a1a2e;
  resize: none;
  outline: none;
  min-height: 38px;
  max-height: 120px;
  overflow-y: auto;
  line-height: 1.4;
  transition: border-color 0.15s;
  font-family: inherit;
}

.tgc-input:focus {
  border-color: #4361ee;
  background: #fff;
}

.tgc-send-btn {
  width: 38px;
  height: 38px;
  border-radius: 50%;
  background: #4361ee;
  border: none;
  color: #fff;
  font-size: 14px;
  cursor: pointer;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  transition:
    opacity 0.15s,
    transform 0.1s;
}

.tgc-send-btn:disabled {
  opacity: 0.35;
  cursor: default;
}

.tgc-send-btn:not(:disabled):hover {
  opacity: 0.85;
}

.tgc-send-btn:not(:disabled):active {
  transform: scale(0.93);
}

/* ── Empty states ───────────────────────────────────────────────────────────── */
.tgc-empty-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: #bbb;
  gap: 12px;
  font-size: 14px;
  background: #f5f7fb;
}

.tgc-empty-list,
.tgc-empty-chat {
  text-align: center;
  color: #aaa;
  font-size: 13px;
  padding: 24px 16px;
}

.tgc-list-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  color: #e63946;
  font-size: 13px;
  padding: 20px 16px;
  text-align: center;
  line-height: 1.5;
}

.tgc-list-error-icon {
  font-size: 24px;
  opacity: 0.8;
}

.tgc-reconnect-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
  padding: 7px 16px;
  border: none;
  border-radius: 8px;
  background: #4361ee;
  color: #fff;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.15s;
}

.tgc-reconnect-btn:hover:not(:disabled) {
  background: #3451d1;
}

.tgc-reconnect-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.tgc-spinner-sm {
  width: 12px;
  height: 12px;
  border-width: 2px;
}

.tgc-spinner-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px;
}

.tgc-spinner {
  width: 22px;
  height: 22px;
  border: 2px solid #e0e0e8;
  border-top-color: #4361ee;
  border-radius: 50%;
  animation: tgc-spin 0.7s linear infinite;
}

@keyframes tgc-spin {
  to {
    transform: rotate(360deg);
  }
}

.tgc-load-more {
  display: flex;
  justify-content: center;
  padding: 8px;
}

.tgc-load-more-btn {
  background: none;
  border: 1px solid #dde0e8;
  color: #4361ee;
  border-radius: 16px;
  padding: 4px 16px;
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s;
}

.tgc-load-more-btn:hover {
  background: #f0f2f5;
}

/* ── Contacts overlay ───────────────────────────────────────────────────────── */
.tgc-contacts-overlay {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  z-index: 10;
  display: flex;
  align-items: stretch;
  justify-content: flex-end;
  border-radius: 12px;
  overflow: hidden;
}

.tgc-contacts-panel {
  width: 320px;
  background: #fff;
  border-left: 1px solid #e8e9ed;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.tgc-contacts-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid #e8e9ed;
  font-size: 15px;
  font-weight: 600;
  flex-shrink: 0;
  color: #1a1a2e;
}

.tgc-contacts-search {
  position: relative;
  padding: 8px 12px;
  flex-shrink: 0;
}

.tgc-contacts-search .tgc-search-icon {
  top: 50%;
}

.tgc-contacts-search .tgc-search-input {
  padding-left: 30px;
}

.tgc-contact-list {
  flex: 1;
  overflow-y: auto;
  scrollbar-width: thin;
}

.tgc-contact-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  cursor: pointer;
  transition: background 0.1s;
}

.tgc-contact-item:hover {
  background: #f0f2f5;
}

.tgc-contact-info {
  min-width: 0;
}

.tgc-contact-name {
  font-size: 14px;
  font-weight: 500;
  color: #1a1a2e;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tgc-contact-sub {
  font-size: 12px;
  color: #999;
}

.tgc-add-contact {
  border-top: 1px solid #e8e9ed;
  padding: 12px 14px;
  flex-shrink: 0;
}

.tgc-add-contact-title {
  font-size: 12px;
  font-weight: 600;
  color: #888;
  margin-bottom: 8px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.tgc-add-contact-fields {
  display: flex;
  gap: 6px;
}

.tgc-add-contact-fields .form-input {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  padding: 5px 8px;
}

.tgc-add-contact-fields .btn {
  flex-shrink: 0;
  padding: 5px 12px;
  font-size: 13px;
}

/* ── Avatar photo overlay ───────────────────────────────────────────────────── */
.tgc-avatar {
  position: relative;
  overflow: hidden;
}

.tgc-avatar-photo {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: 50%;
}

/* ── Clickable header elements ──────────────────────────────────────────────── */
.tgc-clickable {
  cursor: pointer;
}

.tgc-chat-title-wrap.tgc-clickable:hover .tgc-chat-name {
  color: #4361ee;
}

/* ── Profile panel ──────────────────────────────────────────────────────────── */
.tgc-profile-panel {
  width: 300px;
  flex-shrink: 0;
  background: #fff;
  border-left: 1px solid #e8e9ed;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  animation: tgc-slide-right 0.18s ease;
}

@keyframes tgc-slide-right {
  from {
    transform: translateX(100%);
  }
  to {
    transform: translateX(0);
  }
}

.tgc-profile-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px 10px 16px;
  border-bottom: 1px solid #e8e9ed;
  flex-shrink: 0;
}

.tgc-profile-title {
  font-size: 15px;
  font-weight: 600;
  color: #1a1a2e;
}

.tgc-profile-body {
  flex: 1;
  overflow-y: auto;
  scrollbar-width: thin;
}

.tgc-profile-avatar-wrap {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 24px 16px 16px;
  border-bottom: 1px solid #f0f2f5;
}

.tgc-profile-avatar {
  width: 80px;
  height: 80px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 32px;
  font-weight: 600;
  color: #fff;
  flex-shrink: 0;
  position: relative;
  overflow: hidden;
  margin-bottom: 12px;
}

.tgc-profile-name {
  font-size: 17px;
  font-weight: 600;
  color: #1a1a2e;
  text-align: center;
  word-break: break-word;
}

.tgc-profile-type-badge {
  margin-top: 4px;
  font-size: 12px;
  color: #888;
  text-transform: capitalize;
}

.tgc-contact-edit-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 16px;
  border-bottom: 1px solid #e8eaed;
}

.tgc-contact-edit-input {
  width: 100%;
  box-sizing: border-box;
}

.tgc-contact-edit-actions {
  display: flex;
  gap: 8px;
  align-items: center;
  justify-content: flex-end;
}

.tgc-contact-save-btn {
  padding: 6px 18px;
  border-radius: 6px;
  border: none;
  background: #4361ee;
  color: #fff;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: opacity 0.15s;
  &:disabled {
    opacity: 0.35;
    cursor: default;
  }
  &:not(:disabled):hover {
    opacity: 0.85;
  }
}

.tgc-contact-cancel-btn {
  padding: 6px 14px;
  border-radius: 6px;
  border: 1px solid #ddd;
  background: none;
  color: #555;
  font-size: 13px;
  cursor: pointer;
  transition: background 0.15s;
  &:hover {
    background: #f0f2f5;
  }
}

.tgc-profile-rows {
  padding: 8px 0;
}

.tgc-profile-row {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 12px 16px;
  cursor: pointer;
  transition: background 0.1s;
  min-height: 52px;
}

.tgc-profile-row:hover {
  background: #f5f6fa;
}

.tgc-profile-row-nocopy {
  cursor: default;
}

.tgc-profile-row-nocopy:hover {
  background: none;
}

.tgc-profile-row-icon {
  color: #4361ee;
  font-size: 16px;
  flex-shrink: 0;
  width: 18px;
  text-align: center;
}

.tgc-profile-row-body {
  flex: 1;
  min-width: 0;
}

.tgc-profile-row-label {
  font-size: 11px;
  color: #999;
  margin-bottom: 1px;
}

.tgc-profile-row-value {
  font-size: 14px;
  color: #1a1a2e;
  word-break: break-word;
}

.tgc-profile-row-mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.tgc-bio-text {
  font-size: 13px;
  color: #444;
  line-height: 1.5;
}

.tgc-bio-link {
  color: #2481cc;
  text-decoration: none;
  cursor: pointer;
  &:hover {
    text-decoration: underline;
  }
}

.tgc-copy-icon {
  color: #bbb;
  font-size: 13px;
  flex-shrink: 0;
  transition: color 0.1s;
}

.tgc-profile-row:hover .tgc-copy-icon {
  color: #4361ee;
}

/* ── Copy toast ─────────────────────────────────────────────────────────────── */
.tgc-copy-toast {
  position: absolute;
  bottom: 20px;
  left: 50%;
  transform: translateX(-50%);
  background: rgba(26, 26, 46, 0.85);
  color: #fff;
  font-size: 13px;
  padding: 6px 16px;
  border-radius: 20px;
  pointer-events: none;
  z-index: 100;
  white-space: nowrap;
  animation: tgc-fade-in 0.15s ease;
}

@keyframes tgc-fade-in {
  from {
    opacity: 0;
    transform: translateX(-50%) translateY(6px);
  }
  to {
    opacity: 1;
    transform: translateX(-50%) translateY(0);
  }
}

/* ── Context menu ───────────────────────────────────────────────────────────── */
.tgc-ctx-backdrop {
  position: fixed;
  inset: 0;
  z-index: 50;
}

.tgc-ctx-menu {
  position: fixed;
  background: #fff;
  border: 1px solid #e8e9ed;
  border-radius: 10px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15);
  z-index: 51;
  min-width: 180px;
  padding: 4px 0;
  animation: tgc-fade-in 0.1s ease;
}

.tgc-ctx-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  background: none;
  border: none;
  padding: 9px 14px;
  font-size: 14px;
  color: #1a1a2e;
  cursor: pointer;
  text-align: left;
  transition: background 0.1s;
}

.tgc-ctx-item:hover {
  background: #f0f2f5;
}

.tgc-ctx-item i {
  width: 16px;
  text-align: center;
  color: #666;
}

.tgc-ctx-danger,
.tgc-ctx-danger i {
  color: #e0245e;
}

.tgc-ctx-danger:hover {
  background: #fdecef;
}

.tgc-ctx-divider {
  height: 1px;
  background: #e8e9ed;
  margin: 4px 0;
}

.tgc-pin-icon {
  font-size: 10px;
  color: #aaa;
  flex-shrink: 0;
  transform: rotate(45deg);
}

.tgc-ctx-chevron {
  margin-left: auto;
  font-size: 11px;
  color: #aaa;
  transition: transform 0.15s;
  &.rotated {
    transform: rotate(180deg);
  }
}

.tgc-ctx-folder-item {
  padding-left: 28px;
  font-size: 13px;
  color: #555;
}

.tgc-ctx-folder-emoji {
  width: 18px;
  text-align: center;
  flex-shrink: 0;
}

/* ── Back button ──────────────────────────────────────────────────────────────
   Visibility is controlled by v-show (JS), not CSS alone, so it is reliable
   regardless of screen width or media-query quirks.
────────────────────────────────────────────────────────────────────────────── */
.tgc-back-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  background: none;
  border: none;
  color: #4361ee;
  cursor: pointer;
  padding: 6px 8px;
  border-radius: 6px;
  font-size: 15px;
  font-weight: 500;
  flex-shrink: 0;
  transition:
    background 0.15s,
    color 0.15s;
}

.tgc-back-btn:hover {
  background: #eef0fb;
}

/* "Back" text label -- always shown alongside the arrow */
.tgc-back-label {
  font-size: 13px;
}

/* ── Close button in chat header (always visible) ────────────────────────────
   On mobile the main header is hidden when a chat is open, so this is the
   only way to exit. On desktop it is a convenient shortcut.
────────────────────────────────────────────────────────────────────────────── */
.tgc-chat-close-btn {
  flex-shrink: 0;
}

/* ── Responsive ─────────────────────────────────────────────────────────────── */
@media (max-width: 768px) {
  .tgc-popup {
    height: 100dvh;
    height: 100vh; /* fallback for browsers without dvh */
    max-height: none;
    border-radius: 0;
    width: 100%;
  }

  /* Hide outer header when a chat is open -- chat header takes over */
  .tgc-popup.mobile-chat-open .tgc-header {
    display: none;
  }

  /* Single-panel: sidebar fills the body */
  .tgc-sidebar {
    width: 100%;
    flex-shrink: 0;
    border-right: none;
  }

  /* Chat panel hidden until a chat is opened */
  .tgc-chat {
    display: none;
    width: 100%;
  }

  /* When a chat is open: hide sidebar, show chat */
  .tgc-body.chat-open .tgc-sidebar {
    display: none;
  }

  .tgc-body.chat-open .tgc-chat {
    display: flex;
  }

  /* Empty state stays hidden when sidebar is showing */
  .tgc-empty-state {
    display: none;
  }

  /* Contacts panel full-width on mobile */
  .tgc-contacts-panel {
    width: 100%;
    border-left: none;
  }

  /* Profile panel overlays the chat on mobile */
  .tgc-profile-panel {
    position: absolute;
    inset: 0;
    width: 100%;
    z-index: 20;
    border-left: none;
  }

  /* Message bubbles on narrow screens */
  .tgc-msg-bubble {
    max-width: 85%;
  }

  .tgc-messages {
    padding: 12px;
    -webkit-overflow-scrolling: touch;
  }

  /* Keep the back banner visible in long chats even if an outer container
     ends up scrolling (inert when only the message list scrolls) */
  .tgc-chat-header {
    position: sticky;
    top: 0;
    z-index: 15;
  }

  /* Collapse individual header actions into a single menu so the chat name
     keeps its space */
  .tgc-chat-actions {
    display: none;
  }

  /* Comfortable touch target for the jump-to-latest button */
  .tgc-jump-btn {
    width: 46px;
    height: 46px;
  }

  .tgc-chat-menu-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  /* Tap-to-show message actions on mobile (no hover available) */
  .tgc-msg-wrap.tgc-msg-active .tgc-msg-actions {
    display: flex;
  }

  /* Larger touch targets for message action buttons */
  .tgc-msg-action {
    width: 34px;
    height: 34px;
    font-size: 13px;
  }

  /* Header: hide logo only -- keep "Messenger" title so users have context */
  .tgc-logo {
    display: none;
  }

  .tgc-header-left {
    flex: 1;
    min-width: 0;
    gap: 6px;
  }

  .tgc-account-select {
    flex: 1;
    max-width: none;
    min-width: 0;
    font-size: 14px;
    padding: 5px 8px;
  }

  /* Minimum touch target sizes (Apple HIG recommends 44px) */
  .tgc-icon-btn,
  .tgc-back-btn {
    min-width: 44px;
    min-height: 44px;
    padding: 8px;
  }

  /* Slightly larger send button */
  .tgc-send-btn {
    width: 44px;
    height: 44px;
  }

  /* Bigger folder tab touch targets */
  .tgc-folder-tab {
    padding: 6px 14px;
    font-size: 13px;
  }

  /* Safe-area bottom padding for compose box (iPhone home indicator) */
  .tgc-compose-row {
    padding-bottom: max(10px, env(safe-area-inset-bottom));
  }

  .tgc-dialog-list {
    -webkit-overflow-scrolling: touch;
  }
}

/* ── Thread panel ───────────────────────────────────────────────────────────── */
.tgc-thread-panel {
  width: 300px;
  flex-shrink: 0;
  background: #fff;
  border-left: 1px solid #e8e9ed;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  animation: tgc-slide-right 0.18s ease;
}

.tgc-thread-count {
  font-size: 12px;
  font-weight: 600;
  background: #4361ee;
  color: #fff;
  border-radius: 10px;
  padding: 1px 6px;
  margin-left: 6px;
  vertical-align: middle;
}

.tgc-thread-root {
  border-bottom: 1px solid #f0f2f5;
  padding: 10px 16px;
  background: #f8f9fb;
  flex-shrink: 0;
}

.tgc-thread-root-text {
  font-size: 13px;
  color: #555;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 60px;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
}

.tgc-thread-messages {
  flex: 1;
  overflow-y: auto;
  padding: 10px 14px;
  scrollbar-width: thin;
  display: flex;
  flex-direction: column;
  gap: 6px;
  background: #f5f7fb;
}

.tgc-thread-msg {
  max-width: 90%;
}

.tgc-thread-msg-in {
  align-self: flex-start;
}

.tgc-thread-msg-out {
  align-self: flex-end;
}

.tgc-thread-msg-name {
  font-size: 11px;
  font-weight: 600;
  color: #4361ee;
  margin-bottom: 2px;
}

.tgc-thread-msg-text {
  font-size: 13px;
  line-height: 1.4;
  word-break: break-word;
  padding: 6px 10px;
  border-radius: 10px;
  white-space: pre-wrap;
}

.tgc-thread-msg-in .tgc-thread-msg-text {
  background: #fff;
  border: 1px solid #e8e9ed;
  border-bottom-left-radius: 3px;
  color: #1a1a2e;
}

.tgc-thread-msg-out .tgc-thread-msg-text {
  background: #4361ee;
  color: #fff;
  border-bottom-right-radius: 3px;
}

.tgc-thread-msg-time {
  font-size: 10px;
  color: #bbb;
  margin-top: 2px;
  text-align: right;
}

.tgc-thread-msg-in .tgc-thread-msg-time {
  text-align: left;
}

.tgc-thread-compose {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 8px 12px;
  border-top: 1px solid #e8e9ed;
  flex-shrink: 0;
  background: #fff;
}

@media (max-width: 640px) {
  .tgc-thread-panel {
    position: absolute;
    inset: 0;
    width: 100%;
    z-index: 20;
    border-left: none;
  }
}

/* ── Invite join confirmation overlay ─────────────────────────────────────── */

.tgc-invite-overlay {
  position: fixed;
  inset: 0;
  z-index: 3000;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
}

.tgc-invite-card {
  background: #fff;
  border-radius: 16px;
  padding: 32px 24px 24px;
  max-width: 320px;
  width: 100%;
  text-align: center;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
}

.tgc-invite-icon {
  width: 56px;
  height: 56px;
  border-radius: 50%;
  background: #e8eeff;
  color: #4361ee;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 22px;
  margin: 0 auto 14px;
}

.tgc-invite-title {
  font-size: 18px;
  font-weight: 700;
  color: #111;
  margin-bottom: 6px;
  word-break: break-word;
}

.tgc-invite-meta {
  font-size: 13px;
  color: #666;
  margin-bottom: 24px;
}

.tgc-invite-actions {
  display: flex;
  gap: 10px;
  justify-content: center;
}

.tgc-invite-cancel {
  flex: 1;
  padding: 10px;
  border: 1px solid #ddd;
  border-radius: 8px;
  background: #fff;
  color: #444;
  font-size: 14px;
  cursor: pointer;
}

.tgc-invite-cancel:hover {
  background: #f5f5f5;
}

.tgc-invite-join {
  flex: 1;
  padding: 10px;
  border: none;
  border-radius: 8px;
  background: #4361ee;
  color: #fff;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}

.tgc-invite-join:hover:not(:disabled) {
  background: #3451d1;
}

.tgc-invite-join:disabled {
  opacity: 0.65;
  cursor: not-allowed;
}

.tgc-gourl-card {
  text-align: left;
}

.tgc-gourl-hint {
  font-size: 13px;
  color: #666;
  margin-bottom: 12px;
}

.tgc-gourl-input {
  width: 100%;
  box-sizing: border-box;
  padding: 9px 12px;
  border: 1px solid #ddd;
  border-radius: 8px;
  font-size: 14px;
  margin-bottom: 16px;
  outline: none;
  transition: border-color 0.15s;
}

.tgc-gourl-input:focus {
  border-color: #4361ee;
}

/* ── Group member list ──────────────────────────────────────────────────────── */
.tgc-members {
  border-top: 1px solid #f0f2f5;
  padding: 10px 0 4px;
}

.tgc-members-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: 0 16px 6px;
}

.tgc-members-title {
  font-size: 12px;
  font-weight: 600;
  color: #888;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.tgc-members-count {
  font-size: 12px;
  color: #999;
}

.tgc-members-search {
  position: relative;
  padding: 4px 12px 8px;
}

.tgc-members-search .tgc-search-icon {
  top: 45%;
}

.tgc-member-list {
  max-height: 320px;
  overflow-y: auto;
  scrollbar-width: thin;
}

.tgc-member-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 14px;
  cursor: pointer;
  transition: background 0.1s;
}

.tgc-member-item:hover {
  background: #f0f2f5;
}

.tgc-member-av {
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: 700;
  color: #fff;
  overflow: hidden;
  user-select: none;
}

.tgc-member-body {
  min-width: 0;
}

.tgc-member-name {
  font-size: 14px;
  color: #1a1a2e;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tgc-member-badge {
  margin-left: 6px;
  font-size: 10px;
  font-weight: 600;
  color: #4361ee;
  background: #eef1fe;
  border-radius: 4px;
  padding: 1px 4px;
  text-transform: uppercase;
}

.tgc-member-sub {
  font-size: 12px;
  color: #999;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tgc-members-more {
  display: block;
  width: calc(100% - 28px);
  margin: 6px 14px 10px;
  padding: 7px 10px;
  border: 1px solid #ddd;
  border-radius: 8px;
  background: #fff;
  color: #444;
  font-size: 13px;
  cursor: pointer;
}

.tgc-members-more:disabled {
  opacity: 0.6;
  cursor: default;
}

/* Profile action buttons (block / report) */
.tgc-profile-actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 16px 16px;
}

.tgc-profile-action-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 9px 12px;
  border: 1px solid #ddd;
  border-radius: 8px;
  background: #fff;
  color: #444;
  font-size: 13px;
  cursor: pointer;
}

.tgc-profile-action-btn:hover:not(:disabled) {
  background: #f5f5f5;
}

.tgc-profile-action-btn:disabled {
  opacity: 0.65;
  cursor: not-allowed;
}

.tgc-profile-action-danger,
.tgc-profile-action-danger i {
  color: #d33;
}

.tgc-profile-action-danger:hover:not(:disabled) {
  background: #fdecec;
}

/* Report dialog */
.tgc-report-card {
  text-align: left;
}

.tgc-report-card .tgc-invite-icon,
.tgc-report-card .tgc-invite-title {
  text-align: center;
}

.tgc-report-reasons {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px 12px;
  margin: 12px 0 14px;
}

.tgc-report-reason {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: #444;
  cursor: pointer;
}

.tgc-report-comment {
  resize: vertical;
  font-family: inherit;
}

/* Danger variant of the confirm button */
.tgc-danger-btn {
  background: #d33;
}

.tgc-danger-btn:hover:not(:disabled) {
  background: #b52a2a;
}

/* Delete confirmations */
.tgc-revoke-check {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  font-size: 13px;
  color: #444;
  margin-bottom: 18px;
  cursor: pointer;
}

.tgc-phone-input {
  width: 100%;
  box-sizing: border-box;
  padding: 9px 12px;
  margin-bottom: 10px;
  border: 1px solid #d8dde3;
  border-radius: 8px;
  font-size: 14px;
  outline: none;
}

.tgc-phone-input:focus {
  border-color: #3390ec;
}

.tgc-phone-check {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
  font-size: 12px;
}

.tgc-phone-check-good {
  color: #2e9e5b;
}

.tgc-phone-check-bad {
  color: #e63946;
}

.tgc-phone-check-plain {
  color: #888;
}

.tgc-phone-warning {
  display: flex;
  gap: 7px;
  text-align: left;
  font-size: 12px;
  line-height: 1.5;
  color: #b26a00;
  background: #fff6e5;
  border-radius: 8px;
  padding: 9px 11px;
  margin-bottom: 18px;
}

.tgc-webview-proxy-note {
  font-size: 12px;
  color: #8a6d1a;
  background: #fdf6e3;
  border-bottom: 1px solid #f0e3bb;
  padding: 6px 12px;
  display: flex;
  align-items: center;
  gap: 6px;
}

/* Open link chooser */
.tgc-openlink-card {
  max-width: 360px;
}

.tgc-openlink-url {
  font-size: 13px;
  color: #666;
  word-break: break-all;
  max-height: 80px;
  overflow-y: auto;
  margin-bottom: 20px;
  padding: 8px 10px;
  background: #f7f8fc;
  border-radius: 8px;
  text-align: left;
}

.tgc-openlink-cancel {
  width: 100%;
  margin-top: 10px;
}

/* Clean account confirmation */
.tgc-clean-card {
  max-width: 360px;
}

.tgc-clean-icon {
  background: #fdecec;
  color: #d33;
}

.tgc-clean-account-line {
  font-size: 13px;
  color: #444;
  margin-bottom: 4px;
  word-break: break-word;
}

.tgc-clean-warning {
  margin-top: 10px;
}

.tgc-clean-list {
  text-align: left;
  margin: 8px 0;
  padding-left: 24px;
}

.tgc-clean-list li {
  margin-bottom: 2px;
}

/* Forward picker */
.tgc-forward-card {
  text-align: left;
  max-width: 360px;
}

.tgc-forward-card .tgc-invite-title {
  margin-bottom: 14px;
}

.tgc-forward-list {
  max-height: 300px;
  overflow-y: auto;
  margin-bottom: 14px;
  border: 1px solid #eee;
  border-radius: 8px;
}

.tgc-forward-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 7px 10px;
  border: none;
  background: none;
  font-size: 14px;
  color: #222;
  cursor: pointer;
  text-align: left;
}

.tgc-forward-item:hover:not(:disabled) {
  background: #f2f5ff;
}

.tgc-forward-item:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.tgc-forward-avatar {
  width: 32px;
  height: 32px;
  font-size: 13px;
  flex-shrink: 0;
}

.tgc-forward-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Typing indicator */
.tgc-typing {
  color: #4361ee;
  font-style: italic;
}

/* Multi-select mode */
.tgc-msg-selectable {
  cursor: pointer;
}

.tgc-msg-selectable .tgc-msg-bubble {
  pointer-events: none;
}

.tgc-msg-selected .tgc-msg-bubble {
  outline: 2px solid #4361ee;
  outline-offset: 1px;
}

.tgc-msg-select-tick {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  border: 2px solid #bbb;
  color: transparent;
  font-size: 11px;
  display: flex;
  align-items: center;
  justify-content: center;
  align-self: center;
  margin: 0 6px;
  flex-shrink: 0;
  background: #fff;
}

.tgc-msg-select-tick.checked {
  background: #4361ee;
  border-color: #4361ee;
  color: #fff;
}

.tgc-select-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-top: 1px solid #eee;
  background: #fff;
}

.tgc-select-count {
  font-size: 14px;
  font-weight: 600;
  color: #222;
  flex: 1;
}

.tgc-select-actions {
  display: flex;
  gap: 8px;
}

.tgc-select-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  border: none;
  border-radius: 8px;
  background: #4361ee;
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}

.tgc-select-btn:hover:not(:disabled) {
  background: #3451d1;
}

.tgc-select-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.tgc-select-danger {
  background: #d33;
}

.tgc-select-danger:hover:not(:disabled) {
  background: #b52a2a;
}
</style>
