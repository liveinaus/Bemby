<template>
  <div>
    <div class="page-header">
      <h2 class="page-title">{{ t("logs.title") }}</h2>
      <div
        style="display: flex; gap: 10px; align-items: center; flex-wrap: wrap"
      >
        <select
          v-model="filterJobId"
          class="form-select"
          style="width: 200px"
          @change="onFilterChange"
        >
          <option value="">{{ t("logs.allJobs") }}</option>
          <option v-for="j in jobs" :key="j.id" :value="j.id">
            {{ j.name }}
          </option>
        </select>
        <select
          v-model="filterStatus"
          class="form-select"
          style="width: 150px"
          @change="onFilterChange"
        >
          <option value="">{{ t("common.statusFilterAll") }}</option>
          <option value="success">{{ t("logs.status.success") }}</option>
          <option value="failed">{{ t("logs.status.failed") }}</option>
          <option value="running">{{ t("logs.status.running") }}</option>
        </select>
        <label class="dev-toggle" :title="t('logs.showRetired')">
          <input type="checkbox" v-model="showRetired" @change="onFilterChange" />
          <span class="dev-toggle-label">{{ t("logs.retiredLabel") }}</span>
        </label>
        <label class="dev-toggle" :title="t('logs.showDevLogs')">
          <input type="checkbox" v-model="showDevLogs" />
          <span class="dev-toggle-label">{{ t("logs.devLogsLabel") }}</span>
        </label>
        <input
          v-model="filterText"
          class="form-input"
          style="width: 200px"
          :placeholder="t('logs.filterPlaceholder')"
        />
        <button class="btn btn-ghost" @click="load">
          <i class="fa-solid fa-rotate"></i> {{ t("common.refresh") }}
        </button>
      </div>
    </div>

    <div class="card">
      <PaginationBar
        :page="page"
        :page-size="pageSize"
        :total="total"
        @update:page="onPageChange"
        @update:page-size="onPageSizeChange"
      />
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{{ t("logs.colTime") }}</th>
              <th>{{ t("logs.colJob") }}</th>
              <th class="col-hide-mobile">{{ t("logs.colAccount") }}</th>
              <th>{{ t("logs.colStatus") }}</th>
              <th>{{ t("logs.colMessage") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!logs.length">
              <td colspan="5" class="empty">{{ t("logs.noLogs") }}</td>
            </tr>
            <template v-for="(l, idx) in logs" :key="l.id">
              <tr
                style="cursor: pointer; user-select: none"
                :class="[expandedId === l.id ? 'row-expanded' : idx % 2 === 1 ? 'row-even' : '', l.retired ? 'row-retired' : '']"
                @click="toggleDetail(l)"
              >
                <td class="time-cell">
                  <span class="hide-mobile">{{ fmtDate(l.ranAt) }}</span>
                  <span class="show-mobile" style="display: none">{{
                    fmtDateShort(l.ranAt)
                  }}</span>
                </td>
                <td>
                  {{ l.jobName ?? l.jobId }}
                  <span style="margin-left: 4px; font-size: 11px; color: var(--text-faint)"
                    >▾</span
                  >
                </td>
                <td class="col-hide-mobile">{{ l.accountName ?? "—" }}</td>
                <td>
                  <span :class="statusBadge(l.status)">{{
                    t(`logs.status.${l.status}`)
                  }}</span>
                </td>
                <td class="msg-cell">
                  <div style="display: flex; align-items: center; gap: 8px">
                    <span
                      :title="l.message ?? undefined"
                      :class="{ 'msg-warning': hasWarning(l) }"
                      style="
                        overflow: hidden;
                        text-overflow: ellipsis;
                        white-space: nowrap;
                        flex: 1;
                      "
                      ><i
                        v-if="hasWarning(l)"
                        class="fa-solid fa-triangle-exclamation"
                        style="margin-right: 4px"
                      ></i
                      >{{ l.message ?? "—" }}</span
                    >
                    <!-- A run showing a screen can be watched from here, and taken over -->
                    <button
                      v-if="watchableRun(l)"
                      class="btn btn-sm btn-ghost btn-icon"
                      style="flex-shrink: 0; color: var(--success)"
                      :title="t('manualBrowser.watch')"
                      @click.stop="manualBrowserRunId = watchableRun(l) as string"
                    >
                      <i class="fa-solid fa-eye"></i>
                    </button>
                    <button
                      v-if="l.status === 'running'"
                      class="btn btn-sm btn-danger"
                      style="flex-shrink: 0"
                      :disabled="stopping.has(l.id)"
                      @click.stop="stopJob(l)"
                    >
                      <i class="fa-solid fa-stop"></i>
                      {{
                        stopping.has(l.id)
                          ? t("common.stopping")
                          : t("common.stop")
                      }}
                    </button>
                    <button
                      v-if="l.status === 'failed'"
                      class="btn btn-sm btn-ghost btn-icon"
                      style="flex-shrink: 0; color: var(--text-faint)"
                      :title="t('common.run')"
                      :disabled="rerunning.has(l.id)"
                      @click.stop="rerunJob(l)"
                    >
                      <i class="fa-solid fa-rotate-right"></i>
                    </button>
                    <button
                      v-if="l.status !== 'running'"
                      class="btn btn-sm btn-ghost btn-icon"
                      style="flex-shrink: 0; color: var(--text-faint)"
                      :title="l.retired ? t('logs.unretire') : t('logs.retire')"
                      @click.stop="toggleRetire(l)"
                    >
                      <i :class="l.retired ? 'fa-solid fa-rotate-left' : 'fa-solid fa-box-archive'"></i>
                    </button>
                  </div>
                </td>
              </tr>

              <!-- Detail panel — checkin jobs: chat-style attempt log -->
              <tr v-if="l.jobType === 'checkin' && expandedId === l.id">
                <td
                  colspan="5"
                  style="padding: 0; background: var(--bg-subtle); border-top: none"
                >
                  <div class="detail-panel">
                    <div
                      v-if="detailLoading"
                      style="color: var(--text-muted); font-size: 13px"
                    >
                      {{ t("logs.detail.loading") }}
                    </div>
                    <div
                      v-else-if="!checkinDetail?.length"
                      style="color: var(--text-muted); font-size: 13px"
                    >
                      {{ t("logs.detail.noDetail") }}
                    </div>
                    <div v-else>
                      <div
                        v-for="a in checkinDetail"
                        :key="a.attempt"
                        :style="
                          checkinDetail.length > 1
                            ? 'margin-bottom:16px;padding-bottom:16px;border-bottom:1px solid var(--border)'
                            : ''
                        "
                      >
                        <div
                          v-if="checkinDetail.length > 1"
                          style="
                            font-size: 11px;
                            font-weight: 600;
                            color: var(--text-faint);
                            text-transform: uppercase;
                            letter-spacing: 0.05em;
                            text-align: center;
                            margin-bottom: 10px;
                          "
                        >
                          {{
                            t("logs.detail.attempt").replace(
                              "{n}",
                              String(a.attempt),
                            )
                          }}
                        </div>
                        <div class="chat-bg">
                          <div class="chat-log">
                            <div class="chat-row-sent">
                              <div class="bubble-sent">{{ a.commandSent }}</div>
                            </div>
                            <div
                              v-if="a.commandResponseHtml || a.hasMedia"
                              class="chat-row-recv"
                            >
                              <div>
                                <div class="tg-bubble">
                                  <template
                                    v-if="a.commandResponseImages?.length"
                                  >
                                    <img
                                      v-for="(
                                        src, i
                                      ) in a.commandResponseImages"
                                      :key="i"
                                      :src="src"
                                      class="tg-bubble-img"
                                      alt=""
                                    />
                                  </template>
                                  <div
                                    v-else-if="a.hasMedia"
                                    class="tg-bubble-img-placeholder"
                                  >
                                    📷
                                  </div>
                                  <div
                                    v-if="a.commandResponseHtml"
                                    class="tg-bubble-text"
                                    v-html="a.commandResponseHtml"
                                  />
                                </div>
                                <div
                                  v-if="a.availableButtons?.length"
                                  class="tg-keyboard"
                                >
                                  <div
                                    v-for="(row, ri) in a.availableButtons"
                                    :key="ri"
                                    class="tg-keyboard-row"
                                  >
                                    <div
                                      v-for="btn in row"
                                      :key="btn"
                                      :class="
                                        btn === a.buttonClicked
                                          ? 'tg-btn tg-btn-active'
                                          : 'tg-btn'
                                      "
                                    >
                                      {{ btn }}
                                    </div>
                                  </div>
                                </div>
                              </div>
                            </div>
                            <div v-if="a.buttonClicked" class="chat-row-sent">
                              <div>
                                <div class="bubble-sent">
                                  {{ a.buttonClicked }}
                                </div>
                                <div
                                  v-if="a.aiDurationMs != null"
                                  class="ai-badge"
                                >
                                  AI · {{ a.aiDurationMs }}ms
                                </div>
                              </div>
                            </div>
                            <template v-if="showDevLogs">
                              <div class="dev-block" style="margin-top: 6px">
                                <div class="dev-block-label">
                                  {{ t("logs.dev.timing") }}
                                </div>
                                <div class="dev-timing-grid">
                                  <template v-if="a.totalMs != null"
                                    ><span class="dev-t-key">{{
                                      t("logs.dev.totalMs")
                                    }}</span
                                    ><span class="dev-t-val"
                                      >{{ a.totalMs }}ms</span
                                    ></template
                                  >
                                  <template v-if="a.connectMs != null"
                                    ><span class="dev-t-key">{{
                                      t("logs.dev.connectMs")
                                    }}</span
                                    ><span class="dev-t-val"
                                      >{{ a.connectMs }}ms</span
                                    ></template
                                  >
                                  <template v-if="a.replyLatencyMs != null"
                                    ><span class="dev-t-key">{{
                                      t("logs.dev.replyLatencyMs")
                                    }}</span
                                    ><span class="dev-t-val"
                                      >{{ a.replyLatencyMs }}ms<span
                                        v-if="a.replyTimeoutMs != null"
                                        class="dev-t-note"
                                      >
                                        (limit: {{ a.replyTimeoutMs }}ms)</span
                                      ></span
                                    ></template
                                  >
                                  <template v-if="a.buttonClickMs != null"
                                    ><span class="dev-t-key">{{
                                      t("logs.dev.buttonClickMs")
                                    }}</span
                                    ><span class="dev-t-val"
                                      >{{ a.buttonClickMs }}ms</span
                                    ></template
                                  >
                                  <template v-if="a.buttonResponseMs != null"
                                    ><span class="dev-t-key">{{
                                      t("logs.dev.buttonResponseMs")
                                    }}</span
                                    ><span class="dev-t-val"
                                      >{{ a.buttonResponseMs }}ms<span
                                        v-if="a.buttonResponseSource"
                                        class="dev-t-note"
                                      >
                                        · {{ a.buttonResponseSource }}</span
                                      ></span
                                    ></template
                                  >
                                  <template v-if="a.errorName"
                                    ><span class="dev-t-key">{{
                                      t("logs.dev.errorName")
                                    }}</span
                                    ><span class="dev-t-val dev-t-error">{{
                                      a.errorName
                                    }}</span></template
                                  >
                                </div>
                              </div>
                            </template>
                            <div
                              v-if="
                                a.buttonResponseHtml || a.buttonResponseHasMedia
                              "
                              class="chat-row-recv"
                            >
                              <div>
                                <div class="tg-bubble">
                                  <img
                                    v-if="a.buttonResponseImage"
                                    :src="a.buttonResponseImage"
                                    class="tg-bubble-img"
                                    alt=""
                                  />
                                  <div
                                    v-else-if="a.buttonResponseHasMedia"
                                    class="tg-bubble-img-placeholder"
                                  >
                                    📷
                                  </div>
                                  <div
                                    v-if="a.buttonResponseHtml"
                                    class="tg-bubble-text"
                                    v-html="a.buttonResponseHtml"
                                  />
                                </div>
                                <div
                                  v-if="a.buttonResponseButtons?.length"
                                  class="tg-keyboard"
                                >
                                  <div
                                    v-for="(row, ri) in a.buttonResponseButtons"
                                    :key="ri"
                                    class="tg-keyboard-row"
                                  >
                                    <div
                                      v-for="btn in row"
                                      :key="btn"
                                      class="tg-btn"
                                    >
                                      {{ btn }}
                                    </div>
                                  </div>
                                </div>
                              </div>
                            </div>
                            <div v-if="a.callbackAnswer" class="chat-row-recv">
                              <div class="bubble-callback">
                                {{ a.callbackAnswer }}
                              </div>
                            </div>
                            <div v-if="a.error" class="chat-error">
                              {{ a.error }}
                            </div>
                          </div>
                        </div>
                        <!-- AI debug section outside chat-bg, constrained to match chat-bg width -->
                        <template v-if="showDevLogs && a.aiPrompt != null">
                          <div style="max-width: 420px">
                          <template
                            v-if="
                              debugKey !== `${expandedId}-attempt-${a.attempt}`
                            "
                          >
                            <div class="dev-block" style="margin-top: 8px">
                              <div
                                class="dev-block-label"
                                style="
                                  display: flex;
                                  align-items: center;
                                  justify-content: space-between;
                                "
                              >
                                <span>{{ t("logs.aiPrompt") }}</span>
                                <button
                                  class="btn btn-ghost btn-sm btn-icon debug-open-btn"
                                  :title="t('logs.debug.open')"
                                  @click="openDebugCheckin(a)"
                                >
                                  <i class="fa-solid fa-flask"></i>
                                </button>
                              </div>
                              <img
                                v-for="(src, i) in a.commandResponseImages ??
                                []"
                                :key="i"
                                :src="src"
                                class="dev-block-img"
                                alt="image sent to AI"
                              />
                              <pre class="dev-block-pre">{{ a.aiPrompt }}</pre>
                            </div>
                            <div class="dev-block" style="margin-top: 4px">
                              <div class="dev-block-label">
                                {{ t("logs.aiResponse")
                                }}{{
                                  a.aiDurationMs != null
                                    ? ` (${(a.aiDurationMs / 1000).toFixed(1)}s)`
                                    : ""
                                }}
                              </div>
                              <pre class="dev-block-pre">{{
                                a.aiResponse
                              }}</pre>
                            </div>
                            <div
                              v-if="a.aiRetries?.length"
                              class="dev-block"
                              style="margin-top: 4px"
                            >
                              <div class="dev-block-label">
                                {{ t("logs.aiRetries") }} ({{
                                  a.aiRetries.length
                                }})
                              </div>
                              <pre class="dev-block-pre">{{
                                a.aiRetries
                                  .map((r, i) => `#${i + 1}: ${r}`)
                                  .join("\n")
                              }}</pre>
                            </div>
                          </template>
                          <DebugPanel
                            v-else
                            v-model:prompt="debugPrompt"
                            v-model:model="debugModel"
                            v-model:max-tokens="debugMaxTokens"
                            :images="debugImages"
                            :suppliers="debugSuppliers"
                            :running="debugRunning"
                            :response="debugResponse"
                            :error="debugError"
                            :duration-ms="debugDurationMs"
                            @run="runDebug"
                            @close="debugKey = null"
                          />
                          </div>
                        </template>
                      </div>
                    </div>
                  </div>
                </td>
              </tr>

              <!-- Detail panel — custom and autoreg jobs: step-by-step timeline -->
              <tr v-if="(l.jobType === 'custom' || l.jobType === 'autoreg') && expandedId === l.id">
                <td
                  colspan="5"
                  style="padding: 0; background: var(--bg-subtle); border-top: none"
                >
                  <div class="detail-panel">
                    <div
                      v-if="detailLoading"
                      style="color: var(--text-muted); font-size: 13px"
                    >
                      {{ t("logs.detail.loading") }}
                    </div>
                    <div
                      v-else-if="!customDetail?.length"
                      style="color: var(--text-muted); font-size: 13px"
                    >
                      {{ t("logs.detail.noDetail") }}
                    </div>
                    <div v-else class="custom-steps">
                      <template v-for="(s, sIdx) in customDetail" :key="sIdx">
                      <!-- Opens each run attempt, so a failed first attempt is not read as
                           the verdict of a run that went on to succeed -->
                      <div
                        v-if="s.runAttempt && s.runAttempt !== customDetail[sIdx - 1]?.runAttempt"
                        class="run-attempt-divider"
                      >
                        {{ runAttemptLabel(s.runAttempt) }}
                      </div>
                      <div
                        class="custom-step"
                        :class="
                          s.error && !s.continued && !retriedStepNums.has(stepKey(s))
                            ? 'custom-step-error'
                            : ''
                        "
                        :style="s.depth ? { marginLeft: s.depth * 14 + 'px' } : undefined"
                      >
                        <div class="custom-step-header">
                          <span class="custom-step-num">{{ s.step }}</span>
                          <span class="custom-step-label">{{
                            s.label || s.actionType
                          }}</span>
                          <span
                            v-if="s.durationMs != null"
                            class="custom-step-duration"
                            >{{ s.durationMs }}ms</span
                          >
                          <span
                            v-if="s.error && retriedStepNums.has(stepKey(s))"
                            class="badge badge-orange"
                            style="font-size: 10px"
                            >retried</span
                          >
                          <span
                            v-else-if="s.error && s.continued"
                            class="badge badge-orange"
                            style="font-size: 10px"
                            >carried on</span
                          >
                          <span
                            v-else-if="s.error"
                            class="badge badge-red"
                            style="font-size: 10px"
                            >failed</span
                          >
                          <span
                            v-else-if="s.result"
                            class="badge badge-green"
                            style="font-size: 10px"
                            >ok</span
                          >
                        </div>
                        <!-- Pre-click context: bot message received while waiting for buttons -->
                        <div
                          v-if="
                            s.preClickHtml ||
                            s.preClickImage ||
                            s.preClickHasMedia ||
                            s.preClickButtons?.length
                          "
                          class="chat-bg"
                          style="margin-top: 6px"
                        >
                          <div class="chat-log">
                            <div class="chat-row-recv">
                              <div>
                                <div class="tg-bubble">
                                  <img
                                    v-if="s.preClickImage"
                                    :src="s.preClickImage"
                                    class="tg-bubble-img"
                                    alt=""
                                  />
                                  <div
                                    v-else-if="s.preClickHasMedia"
                                    class="tg-bubble-img-placeholder"
                                  >
                                    📷
                                  </div>
                                  <div
                                    v-if="s.preClickHtml"
                                    class="tg-bubble-text"
                                    v-html="s.preClickHtml"
                                  />
                                </div>
                                <div
                                  v-if="s.preClickButtons?.length"
                                  class="tg-keyboard"
                                >
                                  <div
                                    v-for="(row, ri) in s.preClickButtons"
                                    :key="ri"
                                    class="tg-keyboard-row"
                                  >
                                    <div
                                      v-for="btn in row"
                                      :key="btn"
                                      :class="
                                        btn === s.clickedButton
                                          ? 'tg-btn tg-btn-active'
                                          : 'tg-btn'
                                      "
                                    >
                                      {{ btn }}
                                    </div>
                                  </div>
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>
                        <div
                          v-if="
                            showDevLogs &&
                            (s.msgCount != null ||
                              s.responseSource ||
                              s.retryCount != null ||
                              s.errorName)
                          "
                          class="dev-step-meta"
                        >
                          <span v-if="s.msgCount != null"
                            >{{ t("logs.dev.msgCount") }}:
                            {{ s.msgCount }}</span
                          >
                          <span v-if="s.responseSource"
                            >{{ t("logs.dev.responseSource") }}:
                            {{ s.responseSource }}</span
                          >
                          <span v-if="s.retryCount != null"
                            >{{ t("logs.dev.retryCount") }}:
                            {{ s.retryCount }}</span
                          >
                          <span v-if="s.errorName"
                            >{{ t("logs.dev.errorName") }}:
                            {{ s.errorName }}</span
                          >
                        </div>
                        <div
                          v-if="s.callbackAnswer"
                          class="custom-step-callback"
                        >
                          {{ s.callbackAnswer }}
                        </div>
                        <!-- Browser (Cloudflare / Mini App) outcome: the page the
                             browser ended up on is otherwise invisible from here -->
                        <div v-if="s.cfHost" class="dev-step-meta">
                          <span>{{ t("logs.cf.host") }}: {{ s.cfHost }}</span>
                          <span v-if="s.cfProxy"
                            >{{ t("logs.cf.proxy") }}: {{ s.cfProxy
                            }}{{
                              s.cfAttempts && s.cfAttempts > 1
                                ? ` (${s.cfAttempts})`
                                : ""
                            }}</span
                          >
                          <span
                            >{{ t("logs.cf.challenge") }}:
                            {{
                              s.cfChallenged
                                ? s.cfPassed
                                  ? t("logs.cf.passed")
                                  : t("logs.cf.refused")
                                : t("logs.cf.none")
                            }}</span
                          >
                          <!-- Which build ran. The free one is older and passes fewer
                               challenges, so a step that fell back to it is called out -->
                          <span
                            v-if="s.cfBuild"
                            :style="s.cfBuild === 'free' ? 'color:var(--warning)' : undefined"
                            :title="s.cfBuild === 'free' ? t('logs.cf.buildFreeHint') : ''"
                            >{{ t("logs.cf.build") }}:
                            {{
                              s.cfBuild === "keyed"
                                ? t("logs.cf.buildKeyed")
                                : t("logs.cf.buildFree")
                            }}</span
                          >
                          <!-- Whose cookies the step had: a login the site keeps asking
                               for is usually a profile name resolving elsewhere -->
                          <span v-if="s.cfProfile"
                            >{{ t("logs.cf.profile") }}: {{ s.cfProfile }}</span
                          >
                          <!-- The machine the page saw. It only stands still where the
                               profile does, so a figure repeating run after run says the
                               profile is being kept when it was meant to be thrown away -->
                          <span v-if="s.cfDevice"
                            >{{ t("logs.cf.device") }}: {{ s.cfDevice }}</span
                          >
                          <!-- Which language the browser asked pages for, and whether that
                               was pinned in Settings rather than taken from the exit -->
                          <span v-if="s.cfLocale"
                            >{{ t("logs.cf.locale") }}: {{ s.cfLocale
                            }}{{ s.cfLocalePinned ? ` (${t("logs.cf.localePinned")})` : "" }}</span
                          >
                          <span v-if="s.cfMiniApp"
                            >{{ t("logs.cf.signed") }}:
                            {{ s.cfMiniAppSigned ? "✓" : "✗" }}</span
                          >
                          <span v-if="s.cfMiniAppAction"
                            >{{ t("logs.cf.inApp") }}:
                            {{ s.cfMiniAppAction }}</span
                          >
                          <span v-if="s.cfPageTitle"
                            >{{ t("logs.cf.pageTitle") }}:
                            {{ s.cfPageTitle }}</span
                          >
                          <span v-if="s.cfNavError" style="color: var(--danger)"
                            >{{ t("logs.cf.navError") }}:
                            {{ s.cfNavError }}</span
                          >
                        </div>
                        <div
                          v-if="showDevLogs && s.cfTrace?.length"
                          class="dev-block"
                          style="margin-top: 4px"
                        >
                          <div class="dev-block-label">
                            {{ t("logs.cf.trace") }}
                          </div>
                          <pre class="dev-block-pre">{{
                            s.cfTrace.join("\n")
                          }}</pre>
                        </div>
                        <!-- open_url: one card per sub-step, with the page after it ran -->
                        <div
                          v-if="s.webSteps?.length"
                          class="dev-block"
                          style="margin-top: 4px"
                        >
                          <div class="dev-block-label">
                            {{ t("logs.web.steps") }}
                          </div>
                          <div
                            v-for="(w, wi) in s.webSteps"
                            :key="wi"
                            class="web-shot"
                          >
                            <div class="web-shot-head">
                              <span class="web-shot-num">{{ wi + 1 }}</span>
                              <span v-if="w.iteration" class="web-shot-loop">{{
                                w.iteration
                              }}</span>
                              <span class="web-shot-type">{{
                                t("jobs.web.type." + w.type)
                              }}</span>
                              <span
                                v-if="w.error"
                                style="color: var(--danger)"
                                >{{ w.error }}</span
                              >
                              <span v-else style="color: var(--success)">{{
                                w.outcome ?? w.label
                              }}</span>
                            </div>
                            <a
                              v-if="w.screenshot"
                              :href="w.screenshot"
                              target="_blank"
                            >
                              <img
                                :src="w.screenshot"
                                class="dev-block-img"
                                alt="page after step"
                              />
                            </a>
                            <!-- One card per AI pass: the picture the model was shown, the
                                 prompt it was shown with, and its reply. The flask re-asks
                                 that pass on its own, with an edited wording -->
                            <template
                              v-for="(ai, pi) in showDevLogs
                                ? webAiPasses(w)
                                : []"
                              :key="pi"
                            >
                              <template
                                v-if="
                                  debugKey !==
                                  `${expandedId}-${sIdx}-web-${wi}-${pi}`
                                "
                              >
                                <div class="dev-block" style="margin-top: 4px">
                                  <div
                                    class="dev-block-label"
                                    style="
                                      display: flex;
                                      align-items: center;
                                      justify-content: space-between;
                                    "
                                  >
                                    <span
                                      >{{ t("logs.aiPrompt")
                                      }}{{ ai.label ? ` — ${ai.label}` : "" }}</span
                                    >
                                    <!-- No picture kept, no debugging: re-asking a vision
                                         prompt without its image answers nothing -->
                                    <button
                                      class="btn btn-ghost btn-sm btn-icon debug-open-btn"
                                      :disabled="!ai.image"
                                      :title="t('logs.debug.open')"
                                      @click="openDebugWeb(ai, sIdx, wi, pi)"
                                    >
                                      <i class="fa-solid fa-flask"></i>
                                    </button>
                                  </div>
                                  <a
                                    v-if="ai.image"
                                    :href="ai.image"
                                    target="_blank"
                                  >
                                    <img
                                      :src="ai.image"
                                      class="dev-block-img"
                                      alt="image sent to AI"
                                    />
                                  </a>
                                  <pre class="dev-block-pre">{{ ai.prompt }}</pre>
                                </div>
                                <div
                                  v-if="ai.reply"
                                  class="dev-block"
                                  style="margin-top: 4px"
                                >
                                  <div class="dev-block-label">
                                    {{ t("logs.aiResponse") }}
                                  </div>
                                  <pre class="dev-block-pre">{{ ai.reply }}</pre>
                                </div>
                              </template>
                              <DebugPanel
                                v-else
                                v-model:prompt="debugPrompt"
                                v-model:model="debugModel"
                                v-model:max-tokens="debugMaxTokens"
                                :images="debugImages"
                                :suppliers="debugSuppliers"
                                :running="debugRunning"
                                :response="debugResponse"
                                :error="debugError"
                                :duration-ms="debugDurationMs"
                                @run="runDebug"
                                @close="debugKey = null"
                              />
                            </template>
                          </div>
                        </div>
                        <div
                          v-if="s.cfScreenshot"
                          class="dev-block"
                          style="margin-top: 4px"
                        >
                          <div class="dev-block-label">
                            {{ t("logs.cf.screenshot") }}
                          </div>
                          <a :href="s.cfScreenshot" target="_blank">
                            <img
                              :src="s.cfScreenshot"
                              class="dev-block-img"
                              alt="browser page"
                            />
                          </a>
                        </div>
                        <!-- Response after the action -->
                        <div
                          v-if="
                            s.responseHtml ||
                            s.responseImage ||
                            s.responseHasMedia ||
                            s.responseButtons?.length
                          "
                          class="chat-bg"
                          style="margin-top: 6px"
                        >
                          <div class="chat-log">
                            <div class="chat-row-recv">
                              <div>
                                <div class="tg-bubble">
                                  <img
                                    v-if="s.responseImage"
                                    :src="s.responseImage"
                                    class="tg-bubble-img"
                                    alt=""
                                  />
                                  <div
                                    v-else-if="s.responseHasMedia"
                                    class="tg-bubble-img-placeholder"
                                  >
                                    📷
                                  </div>
                                  <div
                                    v-if="s.responseHtml"
                                    class="tg-bubble-text"
                                    v-html="s.responseHtml"
                                  />
                                </div>
                                <div
                                  v-if="s.responseButtons?.length"
                                  class="tg-keyboard"
                                >
                                  <div
                                    v-for="(row, ri) in s.responseButtons"
                                    :key="ri"
                                    class="tg-keyboard-row"
                                  >
                                    <div
                                      v-for="btn in row"
                                      :key="btn"
                                      class="tg-btn"
                                    >
                                      {{ btn }}
                                    </div>
                                  </div>
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>
                        <div
                          v-if="s.error"
                          class="chat-error"
                          style="margin-top: 4px"
                        >
                          {{ s.error }}
                        </div>
                        <template v-if="s.aiPrompt != null">
                          <template v-if="debugKey !== `${expandedId}-${sIdx}`">
                            <div class="dev-block" style="margin-top: 8px">
                              <div
                                class="dev-block-label"
                                style="
                                  display: flex;
                                  align-items: center;
                                  justify-content: space-between;
                                "
                              >
                                <span>{{ t("logs.aiPrompt") }}</span>
                                <button
                                  class="btn btn-ghost btn-sm btn-icon debug-open-btn"
                                  :title="t('logs.debug.open')"
                                  @click="openDebug(s, sIdx)"
                                >
                                  <i class="fa-solid fa-flask"></i>
                                </button>
                              </div>
                              <img
                                v-if="s.preClickImage"
                                :src="s.preClickImage"
                                class="dev-block-img"
                                alt="image sent to AI"
                              />
                              <pre class="dev-block-pre">{{ s.aiPrompt }}</pre>
                            </div>
                            <div class="dev-block" style="margin-top: 4px">
                              <div class="dev-block-label">
                                {{ t("logs.aiResponse")
                                }}{{
                                  s.aiDurationMs != null
                                    ? ` (${(s.aiDurationMs / 1000).toFixed(1)}s)`
                                    : ""
                                }}
                              </div>
                              <pre class="dev-block-pre">{{
                                s.aiResponse
                              }}</pre>
                            </div>
                            <div
                              v-if="s.aiRetries?.length"
                              class="dev-block"
                              style="margin-top: 4px"
                            >
                              <div class="dev-block-label">
                                {{ t("logs.aiRetries") }} ({{
                                  s.aiRetries.length
                                }})
                              </div>
                              <pre class="dev-block-pre">{{
                                s.aiRetries
                                  .map((r, i) => `#${i + 1}: ${r}`)
                                  .join("\n")
                              }}</pre>
                            </div>
                          </template>
                          <DebugPanel
                            v-else
                            v-model:prompt="debugPrompt"
                            v-model:model="debugModel"
                            v-model:max-tokens="debugMaxTokens"
                            :images="debugImages"
                            :suppliers="debugSuppliers"
                            :running="debugRunning"
                            :response="debugResponse"
                            :error="debugError"
                            :duration-ms="debugDurationMs"
                            @run="runDebug"
                            @close="debugKey = null"
                          />
                        </template>
                      </div>
                      </template>
                    </div>
                  </div>
                </td>
              </tr>

              <!-- Detail panel — embywatch jobs: playback summary -->
              <tr v-if="l.jobType === 'embywatch' && expandedId === l.id">
                <td
                  colspan="5"
                  style="padding: 0; background: var(--bg-subtle); border-top: none"
                >
                  <div class="detail-panel">
                    <div
                      v-if="detailLoading"
                      style="color: var(--text-muted); font-size: 13px"
                    >
                      {{ t("logs.detail.loading") }}
                    </div>
                    <div
                      v-else-if="!embywatchDetail"
                      style="color: var(--text-muted); font-size: 13px"
                    >
                      {{ t("logs.detail.noDetail") }}
                    </div>
                    <div
                      v-else-if="
                        embywatchDetail.episodes &&
                        embywatchDetail.episodes.length
                      "
                      class="emby-detail emby-detail-wide"
                    >
                      <!-- Sequence Play: recall every episode watched -->
                      <div class="emby-title">
                        {{ t("logs.embyDetail.sequence") }} ·
                        {{ embywatchDetail.episodes.length }}
                        <template v-if="embywatchDetail.seriesName">
                          &nbsp;·&nbsp;{{ embywatchDetail.seriesName }}</template
                        >
                      </div>
                      <div class="emby-episode-label">
                        {{ t("logs.embyDetail.totalWatched") }}:
                        {{ fmtSeconds(embywatchDetail.watchedSeconds) }}
                        <template v-if="embywatchDetail.streamedBytes != null">
                          &nbsp;·&nbsp;{{ t("logs.embyDetail.streamed") }}:
                          {{
                            (embywatchDetail.streamedBytes / 1048576).toFixed(1)
                          }}
                          MB
                          <template v-if="embywatchDetail.realWatchTranscoded"
                            >&nbsp;({{
                              t("logs.embyDetail.transcoded")
                            }})</template
                          >
                        </template>
                      </div>
                      <div
                        v-if="embywatchDetail.realWatchNote"
                        class="emby-note"
                      >
                        {{ realWatchNoteText(embywatchDetail.realWatchNote) }}
                      </div>
                      <div class="emby-seq-list">
                        <div
                          v-for="(epi, idx) in embywatchDetail.episodes"
                          :key="idx"
                          class="emby-seq-item"
                        >
                          <div class="emby-seq-head">
                            <span class="emby-seq-index">{{ idx + 1 }}</span>
                            <span class="emby-seq-name">
                              <template v-if="epi.seriesName"
                                >{{ epi.seriesName }} — </template
                              >{{ epi.title }}
                              <template v-if="epi.seasonNumber != null">
                                (S{{
                                  String(epi.seasonNumber).padStart(2, "0")
                                }}E{{
                                  String(epi.episodeNumber ?? 0).padStart(2, "0")
                                }})
                              </template>
                            </span>
                            <span
                              class="emby-seq-badge"
                              :style="
                                epi.markedWatched
                                  ? 'color:var(--success-soft-text)'
                                  : 'color:var(--danger-soft-text)'
                              "
                            >
                              {{
                                epi.markedWatched
                                  ? t("logs.embyDetail.yes")
                                  : t("logs.embyDetail.no")
                              }}
                            </span>
                          </div>
                          <div class="emby-seq-meta">
                            {{ fmtSeconds(epi.startSeconds) }} →
                            {{ fmtSeconds(epi.endSeconds) }}
                            &nbsp;·&nbsp;{{ t("logs.embyDetail.watched") }}
                            {{ fmtSeconds(epi.watchedSeconds) }}
                            <template v-if="epi.streamedBytes != null">
                              &nbsp;·&nbsp;{{
                                (epi.streamedBytes / 1048576).toFixed(1)
                              }}
                              MB
                              <template v-if="epi.realWatchTranscoded"
                                >&nbsp;({{
                                  t("logs.embyDetail.transcoded")
                                }})</template
                              >
                            </template>
                          </div>
                          <div v-if="epi.realWatchNote" class="emby-note">
                            {{ realWatchNoteText(epi.realWatchNote) }}
                          </div>
                        </div>
                      </div>
                    </div>
                    <div v-else class="emby-detail">
                      <div class="emby-title">
                        <template v-if="embywatchDetail.seriesName"
                          >{{ embywatchDetail.seriesName }} —
                          {{ embywatchDetail.title }}</template
                        >
                        <template v-else>{{ embywatchDetail.title }}</template>
                      </div>
                      <div
                        v-if="embywatchDetail.seasonNumber != null"
                        class="emby-episode-label"
                      >
                        S{{
                          String(embywatchDetail.seasonNumber).padStart(2, "0")
                        }}E{{
                          String(embywatchDetail.episodeNumber ?? 0).padStart(
                            2,
                            "0",
                          )
                        }}
                        &nbsp;·&nbsp;{{ embywatchDetail.itemType }}
                      </div>
                      <div class="emby-stats">
                        <div class="emby-stat">
                          <div class="emby-stat-label">
                            {{ t("logs.embyDetail.runtime") }}
                          </div>
                          <div class="emby-stat-value">
                            {{ fmtSeconds(embywatchDetail.runtimeSeconds) }}
                          </div>
                        </div>
                        <div class="emby-stat">
                          <div class="emby-stat-label">
                            {{ t("logs.embyDetail.start") }}
                          </div>
                          <div class="emby-stat-value">
                            {{ fmtSeconds(embywatchDetail.startSeconds) }}
                          </div>
                        </div>
                        <div class="emby-stat">
                          <div class="emby-stat-label">
                            {{ t("logs.embyDetail.end") }}
                          </div>
                          <div class="emby-stat-value">
                            {{ fmtSeconds(embywatchDetail.endSeconds) }}
                          </div>
                        </div>
                        <div class="emby-stat">
                          <div class="emby-stat-label">
                            {{ t("logs.embyDetail.watched") }}
                          </div>
                          <div class="emby-stat-value">
                            {{ fmtSeconds(embywatchDetail.watchedSeconds) }}
                          </div>
                        </div>
                        <div class="emby-stat">
                          <div class="emby-stat-label">
                            {{ t("logs.embyDetail.markedWatched") }}
                          </div>
                          <div
                            class="emby-stat-value"
                            :style="
                              embywatchDetail.markedWatched
                                ? 'color:var(--success-soft-text)'
                                : 'color:var(--danger-soft-text)'
                            "
                          >
                            {{
                              embywatchDetail.markedWatched
                                ? t("logs.embyDetail.yes")
                                : t("logs.embyDetail.no")
                            }}
                          </div>
                        </div>
                        <div
                          v-if="embywatchDetail.streamedBytes != null"
                          class="emby-stat"
                        >
                          <div class="emby-stat-label">
                            {{ t("logs.embyDetail.streamed") }}
                            <template v-if="embywatchDetail.realWatchTranscoded"
                              >&nbsp;({{
                                t("logs.embyDetail.transcoded")
                              }})</template
                            >
                          </div>
                          <div class="emby-stat-value">
                            {{
                              (
                                embywatchDetail.streamedBytes / 1048576
                              ).toFixed(1)
                            }}
                            MB
                          </div>
                        </div>
                        <div
                          v-if="embywatchDetail.sequencePlay"
                          class="emby-stat"
                        >
                          <div class="emby-stat-label">
                            {{ t("logs.embyDetail.episodes") }}
                          </div>
                          <div class="emby-stat-value">
                            {{ embywatchDetail.episodesCompleted ?? 0 }}
                          </div>
                        </div>
                      </div>
                      <div
                        v-if="embywatchDetail.realWatchNote"
                        class="emby-note"
                      >
                        {{ realWatchNoteText(embywatchDetail.realWatchNote) }}
                      </div>
                    </div>
                  </div>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
    </div>

    <ManualBrowser
      v-if="manualBrowserRunId"
      :run-id="manualBrowserRunId"
      @closed="manualBrowserRunId = null"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from "vue";
import DebugPanel from "../components/DebugPanel.vue";
import PaginationBar from "../components/PaginationBar.vue";
import ManualBrowser from "../components/ManualBrowser.vue";
import {
  logsApi,
  jobsApi,
  debugApi,
  settingsApi,
  aiSuppliersApi,
  manualBrowserApi,
  type Log,
  type Job,
  type CheckinAttemptLog,
  type EmbywatchLog,
  type RealWatchNote,
  type CustomStepLog,
  type CustomJobLog,
  type WebStepLog,
  type AiSupplier,
} from "../api/client";
import { t, locale } from "../i18n";
import { usePersistedRef } from "../composables/usePersistedRef";
import { useAvailableFilter } from "../composables/useAvailableFilter";
import { debounce } from "../composables/useDebounce";

const logs = ref<Log[]>([]);
const jobs = ref<Job[]>([]);
const filterJobId = usePersistedRef<number | "">("bemby:logs:filterJobId", "");
const filterText = usePersistedRef<string>("bemby:logs:filterText", "");
const filterStatus = usePersistedRef<string>("bemby:logs:filterStatus", "");
const showDevLogs = usePersistedRef<boolean>("bemby:logs:showDevLogs", false);
const showRetired = usePersistedRef<boolean>("bemby:logs:showRetired", false);
// A deleted or retired job drops out of the dropdown, so the filter goes with it rather than
// leaving the list empty with nothing on screen to say why. The select drives its own reload,
// hence the callback.
useAvailableFilter(filterJobId, () => jobs.value.map((j) => j.id), "", onFilterChange);
const page = ref(1);
const pageSize = usePersistedRef<number>("bemby:logs:pageSize", 50);
const total = ref(0);

const expandedId = ref<number | null>(null);
const expandedDetail = ref<
  CheckinAttemptLog[] | EmbywatchLog[] | CustomJobLog[] | null
>(null);
const detailLoading = ref(false);
const stopping = ref(new Set<number>());
const rerunning = ref(new Set<number>());
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let detailPollTimer: ReturnType<typeof setTimeout> | null = null;

// ── Watching a run's screen ───────────────────────────────────────────────────
// A run only puts a screen up once it reaches the page it has to open, so which rows can be
// watched is polled rather than settled when the list loads: quickly while something is
// running, slowly otherwise, so the eye arrives and goes without a reload.
const manualBrowserRunId = ref<string | null>(null);
const liveRuns = ref<Record<number, string>>({});
const LIVE_RUN_POLL_BUSY_MS = 3000;
const LIVE_RUN_POLL_IDLE_MS = 15000;
let liveRunTimer: ReturnType<typeof setTimeout> | null = null;

/** The run to watch for a row: its job's, while that row is the one still going. */
function watchableRun(log: Log): string | undefined {
  return log.status === "running" ? liveRuns.value[log.jobId] : undefined;
}

async function refreshLiveRuns() {
  try {
    // `watching: false` -- a poll from this list is nobody looking at a screen, and it must
    // not keep a hand-driven session from idling out
    const { runs } = await manualBrowserApi.status({ watching: false });
    const map: Record<number, string> = {};
    for (const r of runs ?? []) if (r.jobId) map[r.jobId] = r.runId;
    liveRuns.value = map;
  } catch {
    liveRuns.value = {};
  }
}

function pollLiveRuns() {
  if (liveRunTimer) clearTimeout(liveRunTimer);
  const busy =
    logs.value.some((l) => l.status === "running") ||
    Object.keys(liveRuns.value).length > 0;
  liveRunTimer = setTimeout(
    async () => {
      await refreshLiveRuns();
      pollLiveRuns();
    },
    busy ? LIVE_RUN_POLL_BUSY_MS : LIVE_RUN_POLL_IDLE_MS,
  );
}

// ── AI debug panel ────────────────────────────────────────────────────────────
const debugKey = ref<string | null>(null);
const debugPrompt = ref("");
const debugImages = ref<string[]>([]);
const debugModel = ref("");
const debugMaxTokens = ref(5000);
const debugSuppliers = ref<AiSupplier[]>([]);
const debugRunning = ref(false);
const debugResponse = ref<string | null>(null);
const debugError = ref<string | null>(null);
const debugDurationMs = ref<number | null>(null);

function openDebugPanel(key: string, prompt: string, images: string[]) {
  if (debugKey.value === key) {
    debugKey.value = null;
    return;
  }
  debugKey.value = key;
  debugPrompt.value = prompt;
  debugImages.value = images;
  debugMaxTokens.value = 5000;
  debugResponse.value = null;
  debugError.value = null;
  debugDurationMs.value = null;
}

function openDebug(step: CustomStepLog, sIdx: number) {
  openDebugPanel(
    `${expandedId.value}-${sIdx}`,
    step.aiPrompt ?? "",
    step.preClickImage ? [step.preClickImage] : [],
  );
}

type WebAiPass = { label: string; prompt: string; reply: string; image?: string };

/** A prompt and a reply split back into the passes they were logged as, headings and all. */
function splitAiPasses(text: string | undefined): { label: string; body: string }[] {
  const parts = (text ?? "").split(/(?:^|\n\n)--- (.+?) ---\n\n/);
  const out: { label: string; body: string }[] = [];
  // Anything before the first heading is a step that made one call and never headed it
  if (parts[0]?.trim()) out.push({ label: "", body: parts[0] });
  for (let i = 1; i < parts.length; i += 2)
    out.push({ label: parts[i], body: parts[i + 1] ?? "" });
  return out;
}

/**
 * The AI passes of one page step, each with the picture it was shown. A step that took a
 * wide look and then a close-up per position logged them in order, so pass and picture line
 * up by index -- and each can be re-asked on its own, which is the only way to tell which
 * pass put the click in the wrong place.
 */
function webAiPasses(step: WebStepLog): WebAiPass[] {
  const prompts = splitAiPasses(step.aiPrompt);
  const replies = splitAiPasses(step.aiResponse);
  return prompts.map((p, i) => ({
    label: p.label,
    prompt: p.body,
    reply: replies[i]?.body ?? "",
    image: step.aiImages?.[i],
  }));
}

/** One pass's debug panel: its own wording and its own picture, nothing from the others. */
function openDebugWeb(pass: WebAiPass, sIdx: number, wIdx: number, pIdx: number) {
  openDebugPanel(
    `${expandedId.value}-${sIdx}-web-${wIdx}-${pIdx}`,
    pass.prompt,
    pass.image ? [pass.image] : [],
  );
}

function openDebugCheckin(attempt: CheckinAttemptLog) {
  openDebugPanel(
    `${expandedId.value}-attempt-${attempt.attempt}`,
    attempt.aiPrompt ?? "",
    attempt.commandResponseImages ?? [],
  );
}

async function runDebug() {
  debugRunning.value = true;
  debugResponse.value = null;
  debugError.value = null;
  debugDurationMs.value = null;
  try {
    const result = await debugApi.runAi(
      debugImages.value,
      debugPrompt.value,
      debugMaxTokens.value,
      debugModel.value || undefined,
    );
    debugResponse.value = result.response;
    debugDurationMs.value = result.durationMs;
  } catch (err: any) {
    debugError.value =
      err?.response?.data?.error ?? err?.message ?? String(err);
  } finally {
    debugRunning.value = false;
  }
}

// Typed accessors for the two detail formats
const checkinDetail = computed(() => {
  const d = expandedDetail.value;
  if (!Array.isArray(d) || !d.length) return null;
  if ("attempt" in d[0]) return d as CheckinAttemptLog[];
  return null;
});

const embywatchDetail = computed(() => {
  const d = expandedDetail.value;
  if (!Array.isArray(d) || !d.length) return null;
  if ("itemType" in d[0]) return d[0] as EmbywatchLog;
  return null;
});

/** A step as shown, tagged with the run attempt it belongs to when there was more than one. */
type CustomStepRow = CustomStepLog & { runAttempt?: number };

const customDetail = computed<CustomStepRow[] | null>(() => {
  const d = expandedDetail.value;
  if (!d) return null;
  // Detail holds one log per run attempt: a job with retryMax > 1 whose first attempt
  // failed leaves that failure here alongside the attempt that succeeded, so every entry
  // is shown -- reading only the first made a successful run look as though it had failed.
  const logs = (Array.isArray(d) ? d : [d]).filter(
    (entry): entry is CustomJobLog =>
      !!entry && Array.isArray((entry as CustomJobLog).steps),
  );
  if (!logs.length) return null;
  return logs.flatMap((entry, i) =>
    entry.steps.map((s) => ({
      ...s,
      ...(logs.length > 1 ? { runAttempt: i + 1 } : {}),
    })),
  );
});

/** How many run attempts the expanded detail holds, for the attempt headings. */
const customRunAttempts = computed(
  () => customDetail.value?.reduce((n, s) => Math.max(n, s.runAttempt ?? 1), 1) ?? 1,
);

/** Identifies a step within its run attempt, so retries are matched inside one attempt only. */
function stepKey(s: CustomStepRow): string {
  return `${s.runAttempt ?? 1}:${s.step}`;
}

// Steps that had at least one failure followed by a success (action-level retries)
const retriedStepNums = computed(() => {
  const steps = customDetail.value;
  if (!steps) return new Set<string>();
  const succeeded = new Set(steps.filter((s) => !s.error).map(stepKey));
  return new Set(steps.filter((s) => s.error && succeeded.has(stepKey(s))).map(stepKey));
});

/** Label for the divider that opens each run attempt. */
function runAttemptLabel(n: number): string {
  return t("logs.detail.runAttempt")
    .replace("{n}", String(n))
    .replace("{total}", String(customRunAttempts.value));
}

onMounted(async () => {
  jobs.value = await jobsApi.list();
  await load();
  await refreshLiveRuns();
  pollLiveRuns();
  settingsApi
    .get()
    .then((s) => {
      if (s.ai_model) debugModel.value = s.ai_model;
    })
    .catch(() => {});
  aiSuppliersApi
    .list()
    .then((list) => {
      debugSuppliers.value = list;
    })
    .catch(() => {});
});

function fetchPage() {
  return logsApi.listPaged({
    page: page.value,
    pageSize: pageSize.value,
    jobId: filterJobId.value,
    showRetired: showRetired.value,
    status: filterStatus.value || undefined,
    search: filterText.value.trim() || undefined,
  });
}

async function load() {
  expandedId.value = null;
  let res = await fetchPage();
  // if the current page emptied out, step back one and reload once
  if (!res.items.length && page.value > 1) {
    page.value -= 1;
    res = await fetchPage();
  }
  logs.value = res.items;
  total.value = res.total;
}

function onFilterChange() {
  page.value = 1;
  load();
}

function onPageChange(p: number) {
  if (p === page.value) return;
  page.value = p;
  load();
}

function onPageSizeChange(size: number) {
  pageSize.value = size;
  page.value = 1;
  load();
}

const debouncedSearch = debounce(onFilterChange, 300);
watch(filterText, () => debouncedSearch());

async function toggleRetire(log: Log) {
  const result = await logsApi.retire(log.id);
  // if we're not showing retired, remove the row immediately when it gets retired
  if (!showRetired.value && result.retired) {
    logs.value = logs.value.filter(l => l.id !== log.id);
  } else {
    log.retired = result.retired;
  }
}

async function stopJob(log: Log) {
  stopping.value.add(log.id);
  stopping.value = new Set(stopping.value);
  try {
    await logsApi.cancel(log.id);
    const poll = async () => {
      try {
        const updated = await logsApi.getOne(log.id);
        const entry = logs.value.find((l) => l.id === log.id);
        if (entry) {
          entry.status = updated.status;
          entry.message = updated.message;
        }
        if (updated.status === "running") {
          pollTimer = setTimeout(poll, 1500);
        } else {
          stopping.value.delete(log.id);
          stopping.value = new Set(stopping.value);
        }
      } catch {
        stopping.value.delete(log.id);
        stopping.value = new Set(stopping.value);
      }
    };
    poll();
  } catch {
    stopping.value.delete(log.id);
    stopping.value = new Set(stopping.value);
  }
}

async function rerunJob(log: Log) {
  if (!confirm(t("logs.confirmRerun"))) return;
  rerunning.value.add(log.id);
  rerunning.value = new Set(rerunning.value);
  try {
    await jobsApi.run(log.jobId);
    await load();
  } finally {
    rerunning.value.delete(log.id);
    rerunning.value = new Set(rerunning.value);
  }
}

function clearDetailPoll() {
  if (detailPollTimer) {
    clearTimeout(detailPollTimer);
    detailPollTimer = null;
  }
}

async function fetchDetail(logId: number, showLoading = true) {
  if (showLoading) detailLoading.value = true;
  try {
    const full = await logsApi.getOne(logId);
    if (expandedId.value !== logId) return null;
    expandedDetail.value = full.detail ?? null;
    const entry = logs.value.find((l) => l.id === logId);
    if (entry) {
      entry.status = full.status;
      entry.message = full.message;
    }
    return full;
  } catch {
    return null;
  } finally {
    if (showLoading) detailLoading.value = false;
  }
}

function scheduleDetailPoll(logId: number) {
  clearDetailPoll();
  detailPollTimer = setTimeout(async () => {
    const full = await fetchDetail(logId, false);
    if (full?.status === "running" && expandedId.value === logId)
      scheduleDetailPoll(logId);
  }, 1000);
}

async function toggleDetail(log: Log) {
  if (expandedId.value === log.id) {
    expandedId.value = null;
    expandedDetail.value = null;
    clearDetailPoll();
    return;
  }
  clearDetailPoll();
  expandedId.value = log.id;
  expandedDetail.value = null;
  const full = await fetchDetail(log.id);
  if (full?.status === "running" && expandedId.value === log.id)
    scheduleDetailPoll(log.id);
}

function statusBadge(s: Log["status"]) {
  const map: Record<string, string> = {
    success: "badge badge-green",
    failed: "badge badge-red",
    running: "badge badge-orange",
  };
  return map[s] ?? "badge badge-grey";
}

onUnmounted(() => {
  if (pollTimer) clearTimeout(pollTimer);
  if (liveRunTimer) clearTimeout(liveRunTimer);
  clearDetailPoll();
});

function fmtDate(iso: string) {
  const localeMap: Record<string, string> = { en: "en-AU", zh: "zh-CN" };
  return new Date(iso).toLocaleString(localeMap[locale.value] ?? "en-AU", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function fmtDateShort(iso: string) {
  const localeMap: Record<string, string> = { en: "en-AU", zh: "zh-CN" };
  return new Date(iso).toLocaleString(localeMap[locale.value] ?? "en-AU", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtSeconds(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0)
    return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function realWatchNoteText(note: RealWatchNote): string {
  return t(`logs.embyDetail.realWatchNote.${note}`);
}

// A run that completed but flagged something (see runWarnings.ts on the backend).
function hasWarning(l: Log): boolean {
  return l.status === "success" && (l.message ?? "").includes("Warning:");
}
</script>

<style scoped>
.row-expanded td {
  background: var(--primary-soft);
}

.row-even td {
  background: var(--bg-muted);
}

.row-retired td {
  opacity: 0.45;
}

/* Emby detail panel */
.emby-detail {
  max-width: 480px;
}

.emby-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 2px;
}

.emby-episode-label {
  font-size: 12px;
  color: var(--text-muted);
  margin-bottom: 14px;
}

.msg-warning {
  color: var(--warning-soft-text);
}

.emby-note {
  font-size: 12px;
  color: var(--warning-soft-text);
  margin: 6px 0 10px;
}

.emby-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}

.emby-stat {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 16px;
  min-width: 90px;
}

.emby-stat-label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-muted);
  margin-bottom: 4px;
}

.emby-stat-value {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
}

.emby-detail-wide {
  max-width: 640px;
}

.emby-seq-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.emby-seq-item {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 12px;
}

.emby-seq-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.emby-seq-index {
  flex: none;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--primary-soft);
  color: var(--text-body);
  font-size: 11px;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.emby-seq-name {
  flex: 1;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.emby-seq-badge {
  flex: none;
  font-size: 12px;
  font-weight: 600;
}

.emby-seq-meta {
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 3px;
  padding-left: 28px;
  font-variant-numeric: tabular-nums;
}

/* Chat background container */
.chat-bg {
  display: inline-block;
  background: var(--bg-inset);
  border-radius: 10px;
  padding: 12px 14px;
  max-width: 420px;
  width: 100%;
  box-sizing: border-box;
}

/* Chat layout */
.chat-log {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.chat-row-sent {
  display: flex;
  justify-content: flex-end;
}
.chat-row-recv {
  display: flex;
  justify-content: flex-start;
}

/* Outgoing bubble (right) */
.bubble-sent {
  background: var(--success-soft);
  border-radius: 14px 14px 4px 14px;
  padding: 8px 12px;
  font-size: 13px;
  font-family: monospace;
  color: var(--text-heading);
  max-width: 75%;
  word-break: break-all;
}

.ai-badge {
  font-size: 11px;
  color: var(--primary);
  text-align: right;
  margin-top: 3px;
  padding-right: 2px;
  font-weight: 500;
}

.bubble-callback {
  background: var(--bg-active);
  border-radius: 14px 14px 14px 4px;
  padding: 6px 10px;
  font-size: 12px;
  color: var(--text-primary);
  max-width: 75%;
  font-style: italic;
}

.chat-error {
  font-size: 12px;
  color: var(--danger);
  text-align: center;
  padding: 2px 0;
}

.tg-bubble {
  display: inline-block;
  background: var(--bg-active);
  border-radius: 14px 14px 14px 4px;
  overflow: hidden;
  max-width: 300px;
  min-width: 80px;
}
.tg-bubble-img {
  width: 100%;
  display: block;
}
.tg-bubble-img-placeholder {
  height: 80px;
  background: var(--bg-track);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 22px;
}
.tg-bubble-text {
  padding: 8px 12px;
  font-size: 13px;
  line-height: 1.55;
  color: var(--text-heading);
}
.tg-bubble-text a {
  color: var(--primary);
}
.tg-bubble-text code {
  background: var(--bg-track);
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 12px;
}
.tg-bubble-text pre {
  background: var(--bg-track);
  padding: 8px;
  border-radius: 4px;
  overflow-x: auto;
}

.tg-keyboard {
  margin-top: 4px;
  max-width: 300px;
}
.tg-keyboard-row {
  display: flex;
  gap: 4px;
  margin-bottom: 4px;
}
.tg-btn {
  flex: 1;
  font-size: 12px;
  padding: 6px 8px;
  border-radius: 8px;
  border: 1.5px solid var(--border-strong);
  background: var(--bg-card);
  color: var(--text-primary);
  text-align: center;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tg-btn-active {
  background: var(--success-soft);
  color: var(--success);
  border-color: var(--success-border);
  font-weight: 600;
}

/* Custom job step timeline */
.custom-steps {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-width: 560px;
}

.run-attempt-divider {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-faint);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  text-align: center;
  margin: 4px 0;
}

.custom-step {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 14px;
  background: var(--bg-card);
}

.custom-step-error {
  border-color: var(--danger-border);
  background: var(--danger-soft);
}

.custom-step-header {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}

.custom-step-num {
  min-width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--primary-soft);
  color: var(--primary-soft-text);
  font-size: 11px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.custom-step-label {
  flex: 1;
  font-weight: 500;
  color: var(--text-primary);
}

.custom-step-duration {
  font-size: 11px;
  color: var(--text-faint);
}

.custom-step-callback {
  margin-top: 6px;
  font-size: 12px;
  color: var(--text-body);
  background: var(--primary-soft);
  border-radius: 4px;
  padding: 4px 8px;
}

/* Developer logs toggle */
.dev-toggle {
  display: flex;
  align-items: center;
  gap: 5px;
  cursor: pointer;
  user-select: none;
}

.dev-toggle-label {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  color: var(--primary);
  padding: 2px 7px;
  border: 1.5px solid var(--primary);
  border-radius: 4px;
}

.dev-toggle input[type="checkbox"] {
  accent-color: var(--primary);
  width: 14px;
  height: 14px;
}

/* AI dev detail blocks */
.dev-block {
  margin-top: 6px;
  background: #1e1e2e;
  border-radius: 8px;
  padding: 8px 12px;
  /* The panel is dark whatever the theme, so its text cannot inherit the page's */
  color: #cdd6f4;
}

.dev-block-label {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--primary);
  margin-bottom: 4px;
}

.dev-block-img {
  display: block;
  max-width: 100%;
  border-radius: 4px;
  margin-bottom: 8px;
  opacity: 0.9;
}

/* One open_url sub-step: what it did, and the page it left behind */
.web-shot {
  margin-bottom: 8px;
}

.web-shot-head {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  font-size: 11px;
  margin-bottom: 4px;
}

.web-shot-num {
  min-width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--info);
  color: var(--text-on-accent);
  font-size: 10px;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
}

.web-shot-type {
  font-weight: 600;
}

/* Which round of a loop the step belongs to, e.g. "2/5 859148" */
.web-shot-loop {
  padding: 0 5px;
  border-radius: 8px;
  background: var(--primary-soft);
  color: var(--primary-soft-text);
  font-size: 10px;
  font-weight: 600;
  flex: none;
}

.dev-block-pre {
  margin: 0;
  font-size: 11px;
  color: #cdd6f4;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: monospace;
  line-height: 1.5;
}

.dev-timing-grid {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 2px 10px;
  align-items: baseline;
}

.dev-t-key {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: #9399b2;
  white-space: nowrap;
}

.dev-t-val {
  font-size: 11px;
  color: #cdd6f4;
  font-family: monospace;
}

.dev-t-note {
  font-size: 10px;
  color: #6c7086;
}

.dev-t-error {
  color: #f38ba8;
}

.dev-step-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 4px;
  padding: 3px 6px;
  background: #1e1e2e;
  border-radius: 4px;
  font-size: 11px;
  color: #9399b2;
  font-family: monospace;
}

.time-cell {
  white-space: nowrap;
}

.msg-cell {
  max-width: 320px;
}

.detail-panel {
  padding: 16px 20px;
}

@media (max-width: 767px) {
  .time-cell {
    font-size: 11px;
  }

  .time-cell .hide-mobile {
    display: none;
  }

  .time-cell .show-mobile {
    display: inline !important;
  }

  .msg-cell {
    max-width: 140px;
  }

  .detail-panel {
    padding: 10px 12px;
  }

  .chat-bg {
    display: block;
    max-width: 100%;
  }

  .custom-steps {
    max-width: 100%;
  }

  .dev-block {
    max-width: 100%;
  }

  .tg-bubble {
    max-width: 100%;
  }

  .tg-keyboard {
    max-width: 100%;
  }
}

.debug-open-btn {
  margin-left: auto;
  opacity: 0.5;
  font-size: 11px;
}
.debug-open-btn:hover,
.debug-open-btn-active {
  opacity: 1;
  color: #89b4fa;
}
</style>
