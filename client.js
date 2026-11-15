window.__ModuleLoader__.load({
  id: 'dsh-overwatch',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useRef, useState } = React

    const NS = 'dshOverwatch'
    const API = '/overwatch/api'
    const TOKEN_KEY = 'dsh-overwatch.write-token'
    // The HTTP contract exposes freshness as `{ok, ageMs, error}`. A source is
    // considered stale by the panel once its sample is older than the default
    // sampling.staleMs (30s) from the technical plan.
    const STALE_MS = 30000
    // Replay pages forward with the opaque cursor the server returns. The room
    // catches up in bounded batches so one poll can never walk an unbounded
    // timeline; the next tick continues where this one stopped.
    const TIMELINE_PAGE_LIMIT = 100
    const TIMELINE_MAX_PAGES = 8
    const TIMELINE_BUFFER = 5000
    const FISH_POLL_MS = 15000
    const TIMELINE_POLL_MS = 5000
    const DOCTOR_POLL_MS = 15000

    const DICT = {
      en: {
        navLabel: 'Overwatch',
        pageTitle: 'Overwatch',
        pageSubtitle: 'A hard-guard observatory for controlled swarms. Every read-only view comes from the loopback HTTP API.',
        guardOnlyBanner: 'guard-only · no watch officer on this run',
        guardOnlyHint: 'The deterministic guard is supervising. Arm with mode supervised (root agent) to enable the M2 watch officer.',
        supervisedBanner: 'supervised · M2 watch officer armed',
        supervisedHint: 'The M2 tool-restricted watch officer may judge L2+ cases; the deterministic guard still owns every hard limit.',
        tabRoom: 'Watch room',
        tabCases: 'Cases',
        refresh: 'Refresh',
        writeOps: 'Write operations',
        writeOpsShow: 'Show writes',
        writeOpsHide: 'Hide writes',
        readOnlyBadge: 'Read-only',
        writeUnlocked: 'Writes unlocked',
        tokenLabel: 'Overwatch token',
        tokenPlaceholder: 'Enter the x-overwatch-token value',
        tokenSave: 'Save for this session',
        tokenClear: 'Clear token',
        tokenSessionHint: 'Stored in sessionStorage only and lost when this tab closes. Never written to logs or displayed in plain text.',
        tokenNotSet: 'No token is set, so the panel stays read-only.',
        tokenSet: 'Token is set for this session.',
        tokenSaved: 'Token saved for this session.',
        tokenCleared: 'Token cleared.',
        tokenMemoryOnly: 'sessionStorage is unavailable; the token is kept in memory for this page only.',
        tokenRequired: 'Enter and save the overwatch token first.',
        writeDisabledHint: 'If the server has no write token, writes are rejected (403 WRITE_DISABLED).',
        writeGuardOnly: 'Writes: arm, disarm, close, resume, purge, and human approvals.',
        loading: 'Loading…',
        noData: 'No data',
        unknown: 'unknown',
        notAvailable: 'unavailable',
        notReported: 'not reported',
        notProvided: 'not provided',
        yes: 'yes',
        no: 'no',
        retry: 'Retry',
        close: 'Close',
        confirm: 'Confirm',
        cancel: 'Cancel',
        asOf: 'Data as of {time}',
        errorTitle: 'Request failed',
        errorUnauthorized: 'Unauthorized: the token is missing or invalid.',
        errorForbidden: 'Write rejected: cross-origin or writes disabled.',
        errorNotFound: 'Run or route not found.',
        errorConflict: 'State conflict: the run may already be armed.',
        errorNetwork: 'Network request failed.',
        errorMalformed: 'The response does not match the API contract.',
        errorGeneric: 'Request failed.',
        emptyTitle: 'No supervised runs yet',
        emptyBody: 'Start supervision from the root agent, or arm a run over HTTP with a write token.',
        emptyTool: 'Option 1: agent tool',
        emptyToolBody: 'The root agent calls the watch_arm tool on an existing run.',
        emptyHttp: 'Option 2: HTTP',
        emptyHttpBody: 'POST to the arm route with the x-overwatch-token header.',
        emptyNote: 'Without a run, this panel stays read-only.',
        runs: 'Supervised runs',
        runCount: '{count} runs',
        groupArmed: 'Armed',
        groupDisarmed: 'Disarmed',
        groupHistory: 'History',
        selectRun: 'Select a run',
        noRunSelected: 'Select a run to see its overview.',
        runIdLabel: 'Run id',
        goal: 'Goal',
        mode: 'Mode',
        status: 'Status',
        state: 'Arm state',
        round: 'Round',
        armedAt: 'Armed at',
        disarmedAt: 'Disarmed at',
        lastEventAt: 'Last event',
        goalEmpty: '(no goal provided)',
        overview: 'Run overview',
        runDetailUnavailable: 'Run detail unavailable',
        noDetail: 'Run detail has not loaded yet.',
        budget: 'Budget',
        budgetUsed: '{spent} / {limit}',
        budgetUnlimited: 'No limit',
        budgetPercent: 'Usage {percent}',
        budgetReserve: 'Reserved {reserve}',
        budgetThresholds: 'Ticks mark 80% (warn) and 95% (danger)',
        budgetUnknown: 'Budget unavailable',
        budgetOk: 'Below the 80% warn threshold',
        budgetAtWarn: 'Above the 80% warn threshold',
        budgetOver: 'Above the 95% danger threshold',
        freshness: 'Source freshness',
        'source.swarm': 'Swarm',
        'source.pressure': 'Pressure',
        'source.fish': 'Fish',
        'fresh.ok': 'ok',
        'fresh.stale': 'stale',
        'fresh.unavailable': 'unavailable',
        'fresh.age': 'sampled {age}',
        'fresh.error': 'error: {message}',
        'fresh.noData': 'Shown once the run detail loads.',
        casesOpen: 'Open cases',
        casesOpenCount: '{count} open',
        casesBySeverity: 'Open cases by severity',
        severity: 'Severity',
        'severity.meaning.L1': 'info',
        'severity.meaning.L2': 'warning',
        'severity.meaning.L3': 'critical',
        'severity.meaning.L4': 'emergency',
        viewCases: 'View cases',
        tasks: 'Swarm snapshot',
        taskQueued: 'Queued',
        taskWorking: 'Working',
        taskReviewing: 'Reviewing',
        taskApproved: 'Approved',
        taskBlocked: 'Blocked',
        taskMerged: 'Merged',
        reviewsOpen: 'Open reviews',
        reviewsOldest: 'Oldest wait',
        mergeQueue: 'Merge queue',
        mergeConflicts: 'Merge conflicts',
        membersCount: 'Members',
        recentEvents: 'Recent watch events',
        recentEventsHint: 'Up to 10. Unknown times stay blank instead of being invented.',
        noEvents: 'No watch events yet.',
        eventSeq: 'Seq',
        eventType: 'Type',
        eventTime: 'Time',
        eventActor: 'Actor',
        eventSummary: 'Summary',
        unknownTime: 'unknown time',
        integrity: 'Lock and log chain',
        watchLog: 'watch.jsonl hash chain',
        watchOfficer: 'Watch officer (M2)',
        watchState: 'Watch state',
        watchWakes: 'Wakes',
        watchTimeouts: 'Timeouts',
        watchTokens: 'Supervisor tokens',
        watchChild: 'Child session',
        watchDisabled: 'Not enabled in this arm mode.',
        'watchState.absent': 'absent',
        'watchState.starting': 'starting',
        'watchState.waking': 'waking',
        'watchState.idle': 'idle',
        'watchState.failed': 'failed',
        'watchState.stopped': 'stopped',
        'watchState.disabled': 'disabled',
        watchLogOk: 'Verified',
        watchLogBad: 'Not verified',
        watchLogCount: '{count} events',
        lockState: 'Run lock',
        lockNotReported: 'Not exposed by the HTTP contract',
        lockHeld: 'Held',
        lockNotHeld: 'Not held',
        lockLost: 'Unavailable',
        serviceVersion: 'Service version',
        serviceMode: 'Service mode',
        dataDir: 'Data directory',
        casesTitle: 'Cases',
        casesSubtitle: 'Read-only records of signals, evidence, actions, and close reasons.',
        filterOpen: 'Open',
        filterAll: 'All',
        caseTable: 'Case list',
        colSeverity: 'Severity',
        colTime: 'Time',
        colCode: 'Code',
        colTitle: 'Title',
        colState: 'State',
        noOpenCases: 'There are no open cases.',
        noCases: 'This run has no cases yet.',
        caseListUnavailable: 'Case list unavailable.',
        casesLimitNote: 'Showing up to the first 100 cases.',
        selectCaseHint: 'Select a row to see details.',
        openCaseA11y: 'Open case {severity} {code} {title}, {state}',
        untitled: '(untitled)',
        caseDetail: 'Case detail',
        caseMeta: 'Details',
        openedAt: 'Opened',
        updatedAt: 'Updated',
        closedAt: 'Closed',
        closeReason: 'Close reason',
        'closeReason.resolved': 'resolved',
        'closeReason.mitigated': 'mitigated',
        'closeReason.escalated': 'escalated',
        'closeReason.false_positive': 'false positive',
        'closeReason.abandoned': 'abandoned',
        signals: 'Signals',
        noSignals: 'No signals recorded.',
        signalCode: 'Code',
        signalValue: 'Value',
        signalThreshold: 'Threshold',
        evidence: 'Evidence references',
        noEvidence: 'No evidence references.',
        evidenceKind: 'Kind',
        evidenceId: 'Id',
        evidenceSource: 'Source',
        evidenceAt: 'At',
        actions: 'Action timeline',
        noActions: 'No actions recorded.',
        actionKind: 'Action',
        actionState: 'State',
        actionAt: 'At',
        decisions: 'Decisions',
        noDecisions: 'No decisions recorded.',
        caseTimeline: 'Case timeline',
        noCaseTimeline: 'No case timeline events.',
        ack: 'Acknowledge takeover (ack)',
        ackNote: 'Note (optional)',
        ackNotePlaceholder: 'Why you are taking over',
        ackConfirm: 'Acknowledge this case?',
        ackSuccess: 'Case acknowledged.',
        ackPending: 'Submitting…',
        ackLocked: 'Writes are hidden. Show writes and set a token to acknowledge.',
        ackClosed: 'This case is closed; no acknowledgement is needed.',
        ackNotOpen: 'This case is no longer open; no acknowledgement is needed.',
        arm: 'Arm',
        armMode: 'Mode',
        armGuard: 'guard (hard guard)',
        armObserve: 'observe (read-only)',
        armSupervised: 'supervised (M2 watch officer)',
        armConfirm: 'Arm this run in {mode} mode?',
        armSuccess: 'Run armed.',
        disarm: 'Disarm',
        disarmReason: 'Disarm reason (optional)',
        disarmReasonPlaceholder: 'e.g. manual stop',
        disarmConfirm: 'Disarm this run?',
        disarmSuccess: 'Run disarmed.',
        armAlready: 'This run is already armed.',
        disarmNotArmed: 'This run is not armed.',
        writeRunRequired: 'Select a run first.',
        closeCase: 'Close case',
        closeReason: 'Close reason',
        closeReasonResolved: 'resolved',
        closeReasonMitigated: 'mitigated',
        closeReasonEscalated: 'escalated',
        closeReasonFalsePositive: 'false positive',
        closeConfirm: 'Close this case?',
        closeSuccess: 'Case closed.',
        closePending: 'Closing…',
        resumeRun: 'Resume run',
        resumeConfirm: 'Resume this paused or throttled run?',
        resumeSuccess: 'Run resumed.',
        purgeRun: 'Purge archived run',
        purgeConfirm: 'Permanently purge the archives of {runId}?',
        purgeSuccess: 'Archived run purged.',
        purgePending: 'Purging…',
        approvals: 'Pending approvals',
        noApprovals: 'No request is waiting for a human.',
        approvalReason: 'Reason',
        approvalExpires: 'Expires {time}',
        approvalApprove: 'Approve and execute',
        approvalReject: 'Reject',
        approvalPending: 'Approving…',
        approvalRejectPending: 'Rejecting…',
        approvalSuccess: 'Approved and executed once.',
        approvalRejected: 'Request rejected.',
        approvalLocked: 'Show writes and set a token to decide approvals.',
        writePending: 'Working…',
        writeError: 'Write failed',
        'mode.guard': 'guard · hard guard',
        'mode.observe': 'observe · read-only',
        'mode.supervised': 'supervised · M2 watch officer',
        'runState.running': 'running',
        'runState.paused': 'paused',
        'runState.arming': 'arming',
        'runState.watching': 'watching',
        'runState.disarming': 'disarming',
        'runState.armed': 'armed',
        'runState.disarmed': 'disarmed',
        'runState.closed': 'closed',
        'runState.ended': 'ended',
        'runState.stopped': 'stopped',
        'runState.starting': 'starting',
        'runState.degraded': 'degraded',
        'runState.failed': 'failed',
        'runState.error': 'error',
        'runState.unknown': 'unknown',
        'caseState.open': 'open',
        'caseState.acknowledged': 'acknowledged',
        'caseState.acting': 'acting',
        'caseState.verifying': 'verifying',
        'caseState.closed': 'closed',
        'caseState.mitigated': 'mitigated',
        'caseState.escalated': 'escalated',
        'caseState.dismissed': 'dismissed',
        'caseState.resolved': 'resolved',
        'caseState.expired': 'expired',
        'caseState.unknown': 'unknown',
        'actionState.intended': 'intended',
        'actionState.executed': 'executed',
        'actionState.verified': 'verified',
        'actionState.failed': 'failed',
        'actionState.skipped': 'skipped',
        'actionState.reverted': 'reverted',
        'actionState.pending': 'pending',
        'actionState.unknown': 'unknown',
        'actionKind.pause': 'pause',
        'actionKind.resume': 'resume',
        'actionKind.throttle': 'throttle',
        'actionKind.notice': 'notice',
        'actionKind.escalate': 'escalate',
        'actionKind.abort': 'abort',
        'actionKind.checkpoint': 'checkpoint',
        'actionKind.noop': 'no-op',
        'actionKind.unknown': 'unknown',
        'errorCode.UNAUTHORIZED': 'missing or invalid token',
        'errorCode.CROSS_ORIGIN': 'cross-origin write rejected',
        'errorCode.WRITE_DISABLED': 'server has no write token',
        'errorCode.NOT_FOUND': 'run or route not found',
        'errorCode.RUN_NOT_FOUND': 'run not found',
        'errorCode.CASE_NOT_FOUND': 'case not found',
        'errorCode.CONFLICT': 'state conflict',
        'errorCode.ALREADY_ARMED': 'run already armed',
        'errorCode.RUN_NOT_ARMED': 'run is not armed',
        'errorCode.RUN_NOT_RUNNING': 'run is not running',
        'errorCode.CASE_CLOSED': 'case is already closed',
        'errorCode.INVALID': 'invalid request',
        'errorCode.INVALID_ARGUMENT': 'invalid argument',
        'errorCode.INVALID_RUN_ID': 'invalid run id',
        'errorCode.INVALID_BODY': 'invalid request body',
        'errorCode.BAD_REQUEST': 'invalid request',
        'errorCode.BODY_TOO_LARGE': 'request body is too large',
        'errorCode.METHOD_NOT_ALLOWED': 'method not allowed',
        'errorCode.NOT_IMPLEMENTED': 'not implemented in M1',
        'errorCode.SWARM_UNAVAILABLE': 'swarm is unavailable',
        'errorCode.WEB_UNAVAILABLE': 'host web server is not ready',
        'errorCode.SERVICE_LOG_CLOSED': 'service log is closed',
        'errorCode.TOKEN_REQUIRED': 'overwatch token is required',
        'errorCode.INTERNAL': 'server internal error',
        'errorCode.LOOPBACK_ONLY': 'loopback access only',
        'errorCode.MALFORMED_RESPONSE': 'malformed response',
        'errorCode.FISH_SOURCE_NOT_FOUND': 'fish source not found',
        'errorCode.RESTORE_TOKEN_REJECTED': 'overwatch rejects the fishkeeper confirmToken',
        'errorCode.INVALID_RESTORE': 'invalid restore record',
        'errorCode.INVALID_PHASE': 'restore phase must be intent or result',
        'errorCode.RESTORE_STALE': 'target files changed after the checkpoint',
        tabFish: 'Fish tank',
        tabReplay: 'Replay',
        fishTitle: 'Fish tank',
        fishSubtitle: 'Read-only fishkeeper checkpoints, audit tails, and a human-confirmed restore flow. File contents never reach this panel.',
        fishHostIndex: 'Host index',
        fishHostHint: 'Read-only index of checkpoint summaries and audit tails built from the fishkeeper data directory.',
        fishIndexAvailable: 'Index available',
        fishIndexUnavailable: 'Index unavailable',
        fishIndexPartial: 'Partially corrupt',
        fishIndexMissing: 'fishkeeper data directory not found: {path}',
        fishIndexMissingHint: 'Install fishkeeper and create a checkpoint first; overwatch only reads this directory and never writes to it.',
        fishIndexErrors: 'Index errors',
        fishDataDir: 'fishkeeper data directory',
        fishSources: 'Sources',
        fishSource: 'Source',
        fishNoSources: 'No fishkeeper source was found.',
        fishNoHostSource: 'This source is not in the host index; showing the fishkeeper browser view only.',
        fishCheckpoints: 'Checkpoints',
        fishNoCheckpoints: 'This source has no checkpoints yet.',
        fishAudit: 'Recent audit',
        fishNoAudit: 'No audit records yet.',
        fishTrigger: 'Trigger',
        fishFiles: 'Files',
        fishStoredBytes: 'Stored',
        fishPinned: 'Pinned',
        fishNotPinned: 'Not pinned',
        fishBaseline: 'Baseline',
        fishAuditAt: 'Time',
        fishAuditAction: 'Action',
        fishAuditResult: 'Result',
        fishAuditCheckpoint: 'Checkpoint',
        fishAuditError: 'Error',
        fishBrowser: 'fishkeeper browser surface',
        fishBrowserAvailable: 'Browser surface available',
        fishBrowserAvailableHint: 'The same-origin browser surface is available; richer state and the human-confirmed restore flow are enabled.',
        fishBrowserChecking: 'Checking the browser surface…',
        fishBrowserIndexOnly: 'Host index only',
        fishBrowserUnavailableHint: 'Restore needs fishkeeper browser credentials and an installed fishkeeper. This view keeps the host index and audit instead of failing.',
        fishBrowserUnauthorized: 'The browser surface returned 401/403: fishkeeper browser credentials are required.',
        fishBrowserNotFound: 'The browser surface returned 404: fishkeeper is not installed or its routes are not registered.',
        fishBrowserNetwork: 'The browser surface is unreachable (network or same-origin restriction).',
        fishBrowserError: 'The browser surface failed: {message}',
        fishBrowserCheckpointsError: 'Checkpoint list unavailable: {message}',
        fishBrowserGeneratedAt: 'Read {time}',
        fishBrowserMode: 'Browser mode',
        fishBrowserSourceStatus: 'Source status',
        fishBrowserReadOnly: 'fishkeeper is in read-only degradation',
        fishRestoreSupported: 'Restore supported',
        fishRestoreUnsupported: 'This source does not support restore; checkpoints are for audit and migration reference only.',
        fishRestoreNeedBrowser: 'Restore needs a browser-visible source from fishkeeper.',
        fishRestoreNeedRun: 'Select a run before restoring, so the intent and result can be recorded.',
        fishRestoreNeedToken: 'Set the overwatch write token before restoring, so the evidence can be recorded.',
        fishRestoreNeedReadOnly: 'This source is read-only; restore is disabled.',
        fishRestoreAction: 'Restore',
        fishRestoreReady: 'Restore preflights first and records the intent in the overwatch log before execution.',
        fishRestoreTitle: 'Restore checkpoint',
        fishRestorePreflight: 'Preflighting…',
        fishRestoreStepPreflight: 'Preflight',
        fishRestoreStepConfirm: 'Confirm',
        fishRestoreStepResult: 'Result',
        fishRestorePlan: 'Impact preview',
        fishRestorePlanCount: '{count} file(s) will be written; {skipped} skipped.',
        fishRestorePlanHint: 'fishkeeper creates a pre-restore checkpoint of the current state, then writes only files declared restorable.',
        fishRestoreWarnings: 'Warnings',
        fishRestoreNoWarnings: 'No warnings.',
        fishRestoreStale: 'Target changed',
        fishRestoreStaleHint: 'These files changed after the checkpoint. Enable the override to continue.',
        fishRestoreOverride: 'Overwrite newer content (overrideStale)',
        fishRestoreFile: 'File',
        fishRestoreActionCol: 'Action',
        fishRestoreStaleCol: 'Stale',
        fishRestoreBytes: 'Bytes',
        fishRestoreFileRestore: 'restore',
        fishRestoreFileSkip: 'skip',
        fishRestoreSkipReason: 'not restorable',
        fishRestoreConfirm: 'Restore checkpoint {id} of {source}?',
        fishRestoreSafety: 'overwatch never creates or forges the fishkeeper confirmToken; it stays in this dialog memory only.',
        fishRestoreSafetyTitle: 'Safety notes',
        fishRestoreSafetyCheckpoint: 'fishkeeper creates a pre-restore safety checkpoint before writing anything.',
        fishRestoreSafetyGit: 'Code rollback is out of scope: use the swarm worktree/branch and git.',
        fishRestoreIntentRecording: 'Recording the restore intent…',
        fishRestoreIntentRecorded: 'Restore intent recorded in the overwatch log.',
        fishRestoreIntentFailed: 'Could not record the restore intent; the restore was not executed.',
        fishRestoreRetryIntent: 'Retry intent',
        fishRestoreExecuting: 'Restoring…',
        fishRestoreExecute: 'Execute restore',
        fishRestorePreflightFailed: 'Preflight failed',
        fishRestoreError: 'Restore failed',
        fishRestoreRetryPreflight: 'Run preflight again',
        fishRestoreNothing: 'This checkpoint has no restorable files.',
        fishRestoreResultTitle: 'Restore result',
        fishRestoreOk: 'Restore succeeded',
        fishRestorePartial: 'Some files failed to restore',
        fishRestoreRestored: '{count} file(s) restored',
        fishRestoreSafetyCheckpointId: 'Pre-restore safety checkpoint',
        fishRestorePerFile: 'Per-file results',
        fishRestoreFileOk: 'ok',
        fishRestoreFileFailed: 'failed',
        fishRestoreRecorded: 'Result recorded in the overwatch log.',
        fishRestoreResultRecording: 'Recording the restore result…',
        fishRestoreResultRecordFailed: 'The restore ran, but its result could not be recorded in the overwatch log.',
        fishRestoreRetryResult: 'Retry result',
        fishRestoreConfirmExpired: 'The confirm token expired or was consumed; run preflight again.',
        fishRestoreStaleBlocked: 'Targets changed; enable the override and run preflight again.',
        fishRestoreReadOnlyError: 'The source is read-only (possibly held by another fishkeeper instance).',
        fishRestoreCloseHint: 'The confirm token is discarded when this dialog closes.',
        replayTitle: 'Replay',
        replaySubtitle: 'Read-only merged timeline in server order; the panel never re-sorts by seq.',
        replayLegend: 'Sources',
        replaySourceCol: 'Source',
        replayEvents: 'Replay events',
        replayCount: 'Loaded {loaded} / {total}',
        replayLoadMore: 'Load more',
        replayLoadingMore: 'Loading more…',
        replayAllLoaded: 'All events loaded',
        replayEmpty: 'This run has no timeline events yet.',
        replayError: 'Timeline unavailable.',
        replayAutoHint: 'Refreshes every 5s and pauses while the page is hidden.',
        replayCursorHint: 'Paging uses the opaque server cursor; no local re-sorting.',
        'source.watch': 'watch',
        doctorTitle: 'Doctor checks',
        doctorSubtitle: 'Read-only checks polled separately so the main views never wait on them.',
        doctorLoading: 'Loading doctor checks…',
        doctorEmpty: 'No doctor checks reported.',
        doctorError: 'Doctor request failed',
        doctorOverallOk: 'All checks pass',
        doctorOverallWarn: 'Warnings present',
        doctorOverallFail: 'Failures present',
        doctorOverallUnknown: 'Not loaded',
        doctorCheck: 'Check',
        doctorStatusCol: 'Status',
        doctorDetailCol: 'Detail',
        'doctorStatus.pass': 'pass',
        'doctorStatus.warn': 'warn',
        'doctorStatus.fail': 'fail',
        'doctorStatus.unknown': 'unknown',
        'trigger.manual': 'manual',
        'trigger.baseline': 'baseline',
        'trigger.auto': 'auto',
        'trigger.pre-restore': 'pre-restore',
        'trigger.diary': 'diary',
        'trigger.persona': 'persona',
        'trigger.memory': 'memory',
        'trigger.unknown': 'unknown trigger',
        'auditAction.restore': 'restore',
        'auditAction.pin': 'pin',
        'auditAction.unpin': 'unpin',
        'auditAction.delete-checkpoint': 'delete checkpoint',
        'auditAction.unknown': 'unknown action',
        'auditResult.ok': 'ok',
        'auditResult.failed': 'failed',
        'auditResult.unknown': 'not reported',
      },
      zh: {
        navLabel: '瞭望塔',
        pageTitle: '瞭望塔',
        pageSubtitle: '受控蜂群的硬闸门观测台；所有只读视图都来自本机回环 HTTP 接口。',
        guardOnlyBanner: 'guard-only · 当前运行没有值班员',
        guardOnlyHint: '确定性硬闸门在监管。根 agent 用 supervised 模式编队后才会启用 M2 值班员。',
        supervisedBanner: 'supervised · M2 值班员已编队',
        supervisedHint: 'M2 值班员（受工具限制）可以判断 L2+ 事件单；所有硬限仍然由确定性硬闸门执行。',
        tabRoom: '值班室',
        tabCases: '事件单',
        refresh: '刷新',
        writeOps: '写操作',
        writeOpsShow: '展开写操作',
        writeOpsHide: '收起写操作',
        readOnlyBadge: '只读',
        writeUnlocked: '写操作已解锁',
        tokenLabel: 'Overwatch token',
        tokenPlaceholder: '输入 x-overwatch-token 的值',
        tokenSave: '保存到本次会话',
        tokenClear: '清除 token',
        tokenSessionHint: '仅保存在 sessionStorage，关闭标签页即失效；不写入日志，也不明文显示。',
        tokenNotSet: '尚未设置 token，面板保持只读。',
        tokenSet: 'Token 已设置（仅本次会话）。',
        tokenSaved: 'Token 已保存到本次会话。',
        tokenCleared: 'Token 已清除。',
        tokenMemoryOnly: 'sessionStorage 不可用；token 只保留在本页内存中。',
        tokenRequired: '请先输入并保存 overwatch token。',
        writeDisabledHint: '服务端未配置写 token 时，写操作会被拒绝（403 WRITE_DISABLED）。',
        writeGuardOnly: '写操作：编队、解散与确认接管。',
        loading: '加载中…',
        noData: '没有数据',
        unknown: '未知',
        notAvailable: '不可用',
        notReported: '未提供',
        notProvided: '未提供',
        yes: '是',
        no: '否',
        retry: '重试',
        close: '关闭',
        confirm: '确认',
        cancel: '取消',
        asOf: '数据时间 {time}',
        errorTitle: '请求失败',
        errorUnauthorized: '未授权：token 缺失或无效。',
        errorForbidden: '写操作被拒绝：跨源或写接口被禁用。',
        errorNotFound: '运行或路由不存在。',
        errorConflict: '状态冲突：该运行可能已经编队。',
        errorNetwork: '网络请求失败。',
        errorMalformed: '响应格式不符合 API 契约。',
        errorGeneric: '请求失败。',
        emptyTitle: '还没有受监管的运行',
        emptyBody: '先让根 agent 调用工具，或用一个写 token 通过 HTTP 编队。',
        emptyTool: '方式一：Agent 工具',
        emptyToolBody: '根 agent 对已有的运行调用 watch_arm 工具。',
        emptyHttp: '方式二：HTTP',
        emptyHttpBody: '带 x-overwatch-token 请求头，POST 到编队路由。',
        emptyNote: '没有运行可显示时，面板保持只读。',
        runs: '受监管运行',
        runCount: '{count} 个运行',
        groupArmed: '已编队',
        groupDisarmed: '已解散',
        groupHistory: '历史',
        selectRun: '选择运行',
        noRunSelected: '选择一个运行查看总览。',
        runIdLabel: '运行 ID',
        goal: '目标',
        mode: '模式',
        status: '状态',
        state: '编队状态',
        round: '轮次',
        armedAt: '编队时间',
        disarmedAt: '解散时间',
        lastEventAt: '最后事件',
        goalEmpty: '（未提供目标）',
        overview: '运行总览',
        runDetailUnavailable: '运行详情不可用',
        noDetail: '运行详情尚未加载。',
        budget: '预算',
        budgetUsed: '已用 {spent} / 上限 {limit}',
        budgetUnlimited: '不限',
        budgetPercent: '用量 {percent}',
        budgetReserve: '预留 {reserve}',
        budgetThresholds: '刻度：80%（警告） / 95%（危险）',
        budgetUnknown: '预算不可用',
        budgetOk: '低于 80% 警告阈值',
        budgetAtWarn: '已超过 80% 警告阈值',
        budgetOver: '已超过 95% 危险阈值',
        freshness: '三源新鲜度',
        'source.swarm': '蜂群',
        'source.pressure': '压力表',
        'source.fish': '鱼缸',
        'fresh.ok': '正常',
        'fresh.stale': '过期',
        'fresh.unavailable': '不可用',
        'fresh.age': '采集于 {age}',
        'fresh.error': '错误：{message}',
        'fresh.noData': '运行详情加载后显示。',
        casesOpen: '未决事件单',
        casesOpenCount: '{count} 张未决',
        casesBySeverity: '未决事件单按级别',
        severity: '严重度',
        'severity.meaning.L1': '提示',
        'severity.meaning.L2': '警告',
        'severity.meaning.L3': '严重',
        'severity.meaning.L4': '紧急',
        viewCases: '查看事件单',
        tasks: '蜂群快照',
        taskQueued: '排队',
        taskWorking: '进行',
        taskReviewing: '评审',
        taskApproved: '通过',
        taskBlocked: '阻塞',
        taskMerged: '已合并',
        reviewsOpen: '未决评审',
        reviewsOldest: '最久等待',
        mergeQueue: '合并队列',
        mergeConflicts: '合并冲突',
        membersCount: '成员',
        recentEvents: '最近 watch 事件',
        recentEventsHint: '最多 10 条；时间未知时留空，不伪造当前时间。',
        noEvents: '还没有 watch 事件。',
        eventSeq: '序号',
        eventType: '类型',
        eventTime: '时间',
        eventActor: '执行者',
        eventSummary: '摘要',
        unknownTime: '时间未知',
        integrity: '锁与日志链',
        watchLog: 'watch.jsonl 哈希链',
        watchOfficer: '值班员（M2）',
        watchState: '值班员状态',
        watchWakes: '唤醒次数',
        watchTimeouts: '超时',
        watchTokens: '值班员 token',
        watchChild: '子会话',
        watchDisabled: '当前编队模式未启用值班员。',
        'watchState.absent': '未启动',
        'watchState.starting': '启动中',
        'watchState.waking': '唤醒中',
        'watchState.idle': '空闲',
        'watchState.failed': '失败降级',
        'watchState.stopped': '已停止',
        'watchState.disabled': '未启用',
        watchLogOk: '校验通过',
        watchLogBad: '校验失败或不可用',
        watchLogCount: '{count} 条事件',
        lockState: '运行锁',
        lockNotReported: 'HTTP 契约未暴露锁状态',
        lockHeld: '已获取',
        lockNotHeld: '未持有',
        lockLost: '不可用',
        serviceVersion: '服务版本',
        serviceMode: '服务模式',
        dataDir: '数据目录',
        casesTitle: '事件单',
        casesSubtitle: '信号、证据、动作与关闭原因的只读记录。',
        filterOpen: '未决',
        filterAll: '全部',
        caseTable: '事件单列表',
        colSeverity: '严重度',
        colTime: '时间',
        colCode: '代码',
        colTitle: '标题',
        colState: '状态',
        noOpenCases: '当前没有未决事件单。',
        noCases: '这个运行还没有事件单。',
        caseListUnavailable: '事件单列表不可用。',
        casesLimitNote: '最多显示前 100 条。',
        selectCaseHint: '点击一行查看详情。',
        openCaseA11y: '打开事件单 {severity} {code} {title}，{state}',
        untitled: '（无标题）',
        caseDetail: '事件单详情',
        caseMeta: '基本信息',
        openedAt: '打开于',
        updatedAt: '更新于',
        closedAt: '关闭于',
        closeReason: '关闭原因',
        'closeReason.resolved': '已解决',
        'closeReason.mitigated': '已缓解',
        'closeReason.escalated': '已升级',
        'closeReason.false_positive': '误报',
        'closeReason.abandoned': '已放弃',
        signals: '信号',
        noSignals: '没有信号记录。',
        signalCode: '代码',
        signalValue: '值',
        signalThreshold: '阈值',
        evidence: '证据引用',
        noEvidence: '没有证据引用。',
        evidenceKind: '类型',
        evidenceId: 'ID',
        evidenceSource: '来源',
        evidenceAt: '时间',
        actions: '动作时间线',
        noActions: '没有动作记录。',
        actionKind: '动作',
        actionState: '状态',
        actionAt: '时间',
        decisions: '决策记录',
        noDecisions: '没有决策记录。',
        caseTimeline: '本单时间线',
        noCaseTimeline: '本单没有时间线事件。',
        ack: '确认接管（ack）',
        ackNote: '备注（可选）',
        ackNotePlaceholder: '说明接管原因',
        ackConfirm: '确认接管这张事件单？',
        ackSuccess: '已确认接管。',
        ackPending: '提交中…',
        ackLocked: '写操作已隐藏。展开写操作并设置 token 后可确认接管。',
        ackClosed: '该事件单已关闭，无需接管。',
        ackNotOpen: '该事件单已不在 open 状态，无需再次接管。',
        arm: '编队',
        armMode: '模式',
        armGuard: 'guard（硬闸门）',
        armObserve: 'observe（只读）',
        armSupervised: 'supervised（M2 值班员）',
        armConfirm: '以 {mode} 模式编队？',
        armSuccess: '运行已编队。',
        disarm: '解散',
        disarmReason: '解散原因（可选）',
        disarmReasonPlaceholder: '例如：人工结束',
        disarmConfirm: '确认解散这次运行？',
        disarmSuccess: '运行已解散。',
        armAlready: '该运行已编队。',
        disarmNotArmed: '该运行未编队。',
        writeRunRequired: '先选择一个运行。',
        closeCase: '关闭事件单',
        closeReason: '关闭原因',
        closeReasonResolved: '已解决',
        closeReasonMitigated: '已缓解',
        closeReasonEscalated: '已升级',
        closeReasonFalsePositive: '误报',
        closeConfirm: '确认关闭这张事件单？',
        closeSuccess: '事件单已关闭。',
        closePending: '关闭中…',
        resumeRun: '恢复运行',
        resumeConfirm: '恢复这次已暂停或被限流的运行？',
        resumeSuccess: '运行已恢复。',
        purgeRun: '清除归档运行',
        purgeConfirm: '永久清除 {runId} 的归档？',
        purgeSuccess: '归档运行已清除。',
        purgePending: '清除中…',
        approvals: '待批准请求',
        noApprovals: '当前没有等待人工决定的请求。',
        approvalReason: '原因',
        approvalExpires: '过期时间 {time}',
        approvalApprove: '批准并执行',
        approvalReject: '拒绝',
        approvalPending: '批准中…',
        approvalRejectPending: '拒绝中…',
        approvalSuccess: '已批准并执行一次。',
        approvalRejected: '请求已拒绝。',
        approvalLocked: '展开写面板并设置令牌后才能处理批准。',
        writePending: '处理中…',
        writeError: '写操作失败',
        'mode.guard': 'guard · 硬闸门',
        'mode.observe': 'observe · 只读',
        'mode.supervised': 'supervised · M2 值班员',
        'runState.running': '运行中',
        'runState.paused': '已暂停',
        'runState.arming': '编队中',
        'runState.watching': '监管中',
        'runState.disarming': '解散中',
        'runState.armed': '已编队',
        'runState.disarmed': '已解散',
        'runState.closed': '已关闭',
        'runState.ended': '已结束',
        'runState.stopped': '已停止',
        'runState.starting': '启动中',
        'runState.degraded': '降级',
        'runState.failed': '失败',
        'runState.error': '错误',
        'runState.unknown': '未知',
        'caseState.open': '未决',
        'caseState.acknowledged': '已接管',
        'caseState.acting': '处置中',
        'caseState.verifying': '验证中',
        'caseState.closed': '已关闭',
        'caseState.mitigated': '已缓解',
        'caseState.escalated': '已升级',
        'caseState.dismissed': '已忽略',
        'caseState.resolved': '已解决',
        'caseState.expired': '已过期',
        'caseState.unknown': '未知',
        'actionState.intended': '已拟议',
        'actionState.executed': '已执行',
        'actionState.verified': '已验证',
        'actionState.failed': '失败',
        'actionState.skipped': '已跳过',
        'actionState.reverted': '已回滚',
        'actionState.pending': '待执行',
        'actionState.unknown': '未知',
        'actionKind.pause': '暂停',
        'actionKind.resume': '恢复',
        'actionKind.throttle': '限流',
        'actionKind.notice': '通知',
        'actionKind.escalate': '升级',
        'actionKind.abort': '中止',
        'actionKind.checkpoint': '检查点',
        'actionKind.noop': '无动作',
        'actionKind.unknown': '未知',
        'errorCode.UNAUTHORIZED': 'token 缺失或无效',
        'errorCode.CROSS_ORIGIN': '跨源写入被拒绝',
        'errorCode.WRITE_DISABLED': '服务端未配置写 token',
        'errorCode.NOT_FOUND': '运行或路由不存在',
        'errorCode.RUN_NOT_FOUND': '运行不存在',
        'errorCode.CASE_NOT_FOUND': '事件单不存在',
        'errorCode.CONFLICT': '状态冲突',
        'errorCode.ALREADY_ARMED': '运行已编队',
        'errorCode.RUN_NOT_ARMED': '运行未编队',
        'errorCode.RUN_NOT_RUNNING': '运行不在运行中',
        'errorCode.CASE_CLOSED': '事件单已关闭',
        'errorCode.INVALID': '请求参数无效',
        'errorCode.INVALID_ARGUMENT': '请求参数无效',
        'errorCode.INVALID_RUN_ID': '运行 ID 无效',
        'errorCode.INVALID_BODY': '请求体无效',
        'errorCode.BAD_REQUEST': '请求参数无效',
        'errorCode.BODY_TOO_LARGE': '请求体过大',
        'errorCode.METHOD_NOT_ALLOWED': '请求方法不允许',
        'errorCode.NOT_IMPLEMENTED': 'M1 尚未实现',
        'errorCode.SWARM_UNAVAILABLE': '蜂群不可用',
        'errorCode.WEB_UNAVAILABLE': '宿主 Web 服务尚未就绪',
        'errorCode.SERVICE_LOG_CLOSED': '服务日志已关闭',
        'errorCode.TOKEN_REQUIRED': '需要 overwatch token',
        'errorCode.INTERNAL': '服务端内部错误',
        'errorCode.LOOPBACK_ONLY': '仅允许本机访问',
        'errorCode.MALFORMED_RESPONSE': '响应格式错误',
        'errorCode.FISH_SOURCE_NOT_FOUND': '鱼缸数据源不存在',
        'errorCode.RESTORE_TOKEN_REJECTED': 'overwatch 拒绝接收 fishkeeper 的 confirmToken',
        'errorCode.INVALID_RESTORE': '恢复记录无效',
        'errorCode.INVALID_PHASE': '恢复阶段必须是 intent 或 result',
        'errorCode.RESTORE_STALE': '目标文件在检查点之后又被修改',
        tabFish: '鱼缸',
        tabReplay: '回放',
        fishTitle: '鱼缸',
        fishSubtitle: '只读的 fishkeeper 检查点、审计尾部与人工确认的恢复流程；文件正文不会进入本面板。',
        fishHostIndex: '宿主索引',
        fishHostHint: '从 fishkeeper 数据目录只读构建的检查点摘要与审计尾部。',
        fishIndexAvailable: '索引可用',
        fishIndexUnavailable: '索引不可用',
        fishIndexPartial: '部分损坏',
        fishIndexMissing: '未找到 fishkeeper 数据目录：{path}',
        fishIndexMissingHint: '需要先安装 fishkeeper 并创建检查点；overwatch 只读这个目录，从不写入。',
        fishIndexErrors: '索引错误',
        fishDataDir: 'fishkeeper 数据目录',
        fishSources: '数据源',
        fishSource: '数据源',
        fishNoSources: '没有找到 fishkeeper 数据源。',
        fishNoHostSource: '该数据源不在宿主索引中；这里只展示 fishkeeper 浏览器面的视图。',
        fishCheckpoints: '检查点',
        fishNoCheckpoints: '该数据源还没有检查点。',
        fishAudit: '最近审计',
        fishNoAudit: '还没有审计记录。',
        fishTrigger: '触发',
        fishFiles: '文件数',
        fishStoredBytes: '占用',
        fishPinned: '已固定',
        fishNotPinned: '未固定',
        fishBaseline: '基线',
        fishAuditAt: '时间',
        fishAuditAction: '动作',
        fishAuditResult: '结果',
        fishAuditCheckpoint: '检查点',
        fishAuditError: '错误',
        fishBrowser: 'fishkeeper 浏览器面',
        fishBrowserAvailable: '浏览器面可用',
        fishBrowserAvailableHint: '同源浏览器面可用：可以查看更丰富的状态，并走人工确认的恢复流程。',
        fishBrowserChecking: '正在检查浏览器面…',
        fishBrowserIndexOnly: '仅宿主索引可用',
        fishBrowserUnavailableHint: '恢复需要浏览器凭据且已安装 fishkeeper；本视图会保留宿主索引与审计，不会崩溃。',
        fishBrowserUnauthorized: '浏览器面返回 401/403：需要 fishkeeper 浏览器凭据。',
        fishBrowserNotFound: '浏览器面返回 404：未安装 fishkeeper 或路由未注册。',
        fishBrowserNetwork: '无法连接浏览器面（网络或同源限制）。',
        fishBrowserError: '浏览器面失败：{message}',
        fishBrowserCheckpointsError: '检查点列表不可用：{message}',
        fishBrowserGeneratedAt: '读于 {time}',
        fishBrowserMode: '浏览器面模式',
        fishBrowserSourceStatus: '数据源状态',
        fishBrowserReadOnly: 'fishkeeper 处于只读降级',
        fishRestoreSupported: '支持恢复',
        fishRestoreUnsupported: '此数据源不支持恢复；检查点仅用于审计与迁移参考。',
        fishRestoreNeedBrowser: '恢复需要一个在 fishkeeper 浏览器面可见的数据源。',
        fishRestoreNeedRun: '先选择一个运行，才能记录恢复意图与结果。',
        fishRestoreNeedToken: '先设置 overwatch 写 token，才能记录恢复证据。',
        fishRestoreNeedReadOnly: '该数据源当前只读，恢复已禁用。',
        fishRestoreAction: '恢复',
        fishRestoreReady: '恢复会先预检，并在执行前把 intent 写入 overwatch 日志。',
        fishRestoreTitle: '恢复检查点',
        fishRestorePreflight: '预检中…',
        fishRestoreStepPreflight: '预检',
        fishRestoreStepConfirm: '确认',
        fishRestoreStepResult: '结果',
        fishRestorePlan: '影响预览',
        fishRestorePlanCount: '将写入 {count} 个文件，跳过 {skipped} 个。',
        fishRestorePlanHint: 'fishkeeper 会先为当前状态创建 pre-restore 检查点，然后只写声明可恢复的文件。',
        fishRestoreWarnings: '警告',
        fishRestoreNoWarnings: '没有警告。',
        fishRestoreStale: '目标已变化',
        fishRestoreStaleHint: '以下文件在检查点之后又被修改；必须打开覆盖开关才能继续。',
        fishRestoreOverride: '覆盖较新内容（overrideStale）',
        fishRestoreFile: '文件',
        fishRestoreActionCol: '动作',
        fishRestoreStaleCol: '已变化',
        fishRestoreBytes: '字节',
        fishRestoreFileRestore: '恢复',
        fishRestoreFileSkip: '跳过',
        fishRestoreSkipReason: '不可恢复',
        fishRestoreConfirm: '确认恢复 {source} 的检查点 {id}？',
        fishRestoreSafety: 'overwatch 不生成、不伪造 fishkeeper 的 confirmToken；确认令牌只存在于这个对话框的内存中。',
        fishRestoreSafetyTitle: '安全说明',
        fishRestoreSafetyCheckpoint: '写入任何文件之前，fishkeeper 会自己创建一个 pre-restore 安全检查点。',
        fishRestoreSafetyGit: '代码回滚不在此流程：请用 swarm 的 worktree/分支与 git。',
        fishRestoreIntentRecording: '正在记录恢复意图…',
        fishRestoreIntentRecorded: '恢复意图已写入 overwatch 日志。',
        fishRestoreIntentFailed: '无法记录恢复意图，恢复未执行。',
        fishRestoreRetryIntent: '重试记录意图',
        fishRestoreExecuting: '正在恢复…',
        fishRestoreExecute: '执行恢复',
        fishRestorePreflightFailed: '预检失败',
        fishRestoreError: '恢复失败',
        fishRestoreRetryPreflight: '重新预检',
        fishRestoreNothing: '该检查点没有可恢复的文件。',
        fishRestoreResultTitle: '恢复结果',
        fishRestoreOk: '恢复成功',
        fishRestorePartial: '部分文件恢复失败',
        fishRestoreRestored: '已恢复 {count} 个文件',
        fishRestoreSafetyCheckpointId: '恢复前安全检查点',
        fishRestorePerFile: '逐文件结果',
        fishRestoreFileOk: '成功',
        fishRestoreFileFailed: '失败',
        fishRestoreRecorded: '结果已写入 overwatch 日志。',
        fishRestoreResultRecording: '正在记录恢复结果…',
        fishRestoreResultRecordFailed: '恢复已执行，但结果未能写入 overwatch 日志。',
        fishRestoreRetryResult: '重试记录结果',
        fishRestoreConfirmExpired: '确认令牌已过期或已被使用；请重新预检。',
        fishRestoreStaleBlocked: '目标已变化；请打开覆盖开关并重新预检。',
        fishRestoreReadOnlyError: '数据源当前只读（可能被另一个 fishkeeper 实例持有）。',
        fishRestoreCloseHint: '关闭对话框会丢弃确认令牌。',
        replayTitle: '回放',
        replaySubtitle: '按服务端顺序展示的只读合并时间轴；面板不会按 seq 重新排序。',
        replayLegend: '来源',
        replaySourceCol: '来源',
        replayEvents: '回放事件',
        replayCount: '已加载 {loaded} / {total}',
        replayLoadMore: '加载更多',
        replayLoadingMore: '加载中…',
        replayAllLoaded: '已全部加载',
        replayEmpty: '这个运行还没有时间线事件。',
        replayError: '时间线不可用。',
        replayAutoHint: '每 5 秒刷新；页面隐藏时暂停。',
        replayCursorHint: '用服务端不透明游标翻页，不做本地排序。',
        'source.watch': '值班员',
        doctorTitle: '自检（doctor）',
        doctorSubtitle: '只读检查，独立轮询，主视图不会等待它。',
        doctorLoading: '自检加载中…',
        doctorEmpty: '没有自检项。',
        doctorError: '自检请求失败',
        doctorOverallOk: '全部通过',
        doctorOverallWarn: '有警告',
        doctorOverallFail: '存在失败项',
        doctorOverallUnknown: '未加载',
        doctorCheck: '检查项',
        doctorStatusCol: '结果',
        doctorDetailCol: '详情',
        'doctorStatus.pass': '通过',
        'doctorStatus.warn': '警告',
        'doctorStatus.fail': '失败',
        'doctorStatus.unknown': '未知',
        'trigger.manual': '手动',
        'trigger.baseline': '基线',
        'trigger.auto': '自动',
        'trigger.pre-restore': '恢复前',
        'trigger.diary': '日记',
        'trigger.persona': '人设',
        'trigger.memory': '记忆',
        'trigger.unknown': '未知触发',
        'auditAction.restore': '恢复',
        'auditAction.pin': '固定',
        'auditAction.unpin': '取消固定',
        'auditAction.delete-checkpoint': '删除检查点',
        'auditAction.unknown': '未知动作',
        'auditResult.ok': '成功',
        'auditResult.failed': '失败',
        'auditResult.unknown': '未提供',
      },
    }

    let translate = (key) => key
    let subscribeLocale = null
    let localeService = null

    function useLocale() {
      const [, force] = useState(0)
      useEffect(() => {
        if (typeof subscribeLocale !== 'function') return undefined
        return subscribeLocale(() => force((value) => value + 1))
      }, [])
      return translate
    }

    function currentLocale() {
      let active = ''
      try {
        const snapshot = localeService?.getLocale?.() ?? localeService?.getSnapshot?.()
        if (snapshot !== undefined && snapshot !== null && typeof snapshot.active === 'string') active = snapshot.active
      } catch {
        active = ''
      }
      if (active === '' && typeof document !== 'undefined') {
        active = document.documentElement?.lang ?? ''
      }
      if (active === '' && typeof navigator !== 'undefined') {
        active = navigator.language ?? ''
      }
      return String(active).toLowerCase().startsWith('zh') ? 'zh' : 'en'
    }

    function intlLocale() {
      return currentLocale() === 'zh' ? 'zh-CN' : 'en-US'
    }

    const formatterCache = new Map()

    function cachedFormatter(key, create) {
      let formatter = formatterCache.get(key)
      if (formatter === undefined) {
        formatter = create()
        formatterCache.set(key, formatter)
      }
      return formatter
    }

    function numberFormat() {
      return cachedFormatter(`n:${intlLocale()}`, () => new Intl.NumberFormat(intlLocale(), { maximumFractionDigits: 1 }))
    }

    function percentFormat() {
      return cachedFormatter(`p:${intlLocale()}`, () => new Intl.NumberFormat(intlLocale(), {
        style: 'percent',
        maximumFractionDigits: 1,
      }))
    }

    function dateTimeFormat() {
      return cachedFormatter(`dt:${intlLocale()}`, () => new Intl.DateTimeFormat(intlLocale(), {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }))
    }

    function relativeFormat() {
      return cachedFormatter(`r:${intlLocale()}`, () => new Intl.RelativeTimeFormat(intlLocale(), { numeric: 'auto' }))
    }

    function unitFormat(unit) {
      return cachedFormatter(`u:${intlLocale()}:${unit}`, () => {
        try {
          return new Intl.NumberFormat(intlLocale(), { style: 'unit', unit, unitDisplay: 'short', maximumFractionDigits: 1 })
        } catch {
          return null
        }
      })
    }

    function formatNumber(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      return numberFormat().format(value)
    }

    function formatPercent(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      return percentFormat().format(value)
    }

    function formatTime(iso) {
      if (typeof iso !== 'string' || iso === '') return '—'
      const value = Date.parse(iso)
      if (!Number.isFinite(value)) return '—'
      return dateTimeFormat().format(new Date(value))
    }

    function hasTime(iso) {
      return typeof iso === 'string' && iso !== '' && Number.isFinite(Date.parse(iso))
    }

    function formatAgo(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—'
      const seconds = Math.max(0, Math.round(ms / 1000))
      let value = seconds
      let unit = 'second'
      if (seconds >= 86400) {
        value = Math.round(seconds / 86400)
        unit = 'day'
      } else if (seconds >= 3600) {
        value = Math.round(seconds / 3600)
        unit = 'hour'
      } else if (seconds >= 60) {
        value = Math.round(seconds / 60)
        unit = 'minute'
      }
      return relativeFormat().format(-value, unit)
    }

    function formatRelative(iso) {
      if (!hasTime(iso)) return '—'
      const diff = Date.parse(iso) - Date.now()
      const seconds = Math.round(diff / 1000)
      const abs = Math.abs(seconds)
      let value = seconds
      let unit = 'second'
      if (abs >= 86400) {
        value = Math.round(seconds / 86400)
        unit = 'day'
      } else if (abs >= 3600) {
        value = Math.round(seconds / 3600)
        unit = 'hour'
      } else if (abs >= 60) {
        value = Math.round(seconds / 60)
        unit = 'minute'
      }
      return relativeFormat().format(value, unit)
    }

    function formatDuration(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—'
      let value = ms / 1000
      let unit = 'second'
      if (ms >= 86400000) {
        value = ms / 86400000
        unit = 'day'
      } else if (ms >= 3600000) {
        value = ms / 3600000
        unit = 'hour'
      } else if (ms >= 60000) {
        value = ms / 60000
        unit = 'minute'
      }
      const formatter = unitFormat(unit)
      if (formatter === null) return `${Math.round(value)} ${unit}`
      return formatter.format(value)
    }

    function formatScalar(value, t) {
      if (value === null || value === undefined || value === '') return '—'
      if (typeof value === 'number') return formatNumber(value)
      if (typeof value === 'boolean') return value ? t('yes') : t('no')
      if (typeof value === 'string') return value
      try {
        const text = JSON.stringify(value)
        if (typeof text === 'string') return text.length > 240 ? `${text.slice(0, 240)}…` : text
      } catch {
        return '—'
      }
      return '—'
    }

    function formatBytes(value) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '—'
      if (value < 1024) return `${formatNumber(value)} B`
      const units = ['KB', 'MB', 'GB', 'TB']
      let amount = value / 1024
      let unit = units[0]
      for (let index = 1; index < units.length && amount >= 1024; index += 1) {
        amount /= 1024
        unit = units[index]
      }
      return `${formatNumber(amount)} ${unit}`
    }

    function summarizeDetail(detail, t) {
      if (detail === null || detail === undefined) return '—'
      if (typeof detail === 'string' || typeof detail === 'number' || typeof detail === 'boolean') return formatScalar(detail, t)
      try {
        const text = JSON.stringify(detail)
        if (typeof text !== 'string') return '—'
        return text.length > 220 ? `${text.slice(0, 220)}…` : text
      } catch {
        return '—'
      }
    }

    function translateCode(t, prefix, code, fallbackKey = 'unknown') {
      if (code === null || code === undefined || code === '') return t(fallbackKey)
      const text = String(code)
      const key = `${prefix}.${text}`
      const translated = t(key)
      return translated === key ? text : translated
    }

    function closeReasonText(t, value) {
      if (value === null || value === undefined || value === '') return t('notProvided')
      return translateCode(t, 'closeReason', value)
    }

    function armModeLabel(t, mode) {
      if (mode === 'supervised') return t('armSupervised')
      if (mode === 'observe') return t('armObserve')
      return t('armGuard')
    }

    function watchStateLabel(t, state) {
      if (typeof state !== 'string' || state === '') return t('unknown')
      return translateCode(t, 'watchState', state)
    }

    function severityText(t, severity) {
      const code = typeof severity === 'string' && severity !== '' ? severity.toUpperCase() : ''
      if (code === '') return t('unknown')
      const key = `severity.meaning.${code}`
      const meaning = t(key)
      return meaning === key ? code : `${code} ${meaning}`
    }

    function triggerLabel(t, trigger) {
      if (typeof trigger !== 'string' || trigger === '') return t('trigger.unknown')
      return translateCode(t, 'trigger', trigger, 'trigger.unknown')
    }

    function auditActionLabel(t, action) {
      if (typeof action !== 'string' || action === '') return t('auditAction.unknown')
      return translateCode(t, 'auditAction', action, 'auditAction.unknown')
    }

    function auditResultLabel(t, result) {
      if (typeof result !== 'string' || result === '') return t('auditResult.unknown')
      return translateCode(t, 'auditResult', result, 'auditResult.unknown')
    }

    function sourceLabel(t, source) {
      if (typeof source !== 'string' || source === '') return t('unknown')
      return translateCode(t, 'source', source, 'unknown')
    }

    function doctorStatusLabel(t, status) {
      const key = `doctorStatus.${typeof status === 'string' ? status : 'unknown'}`
      const text = t(key)
      return text === key ? t('doctorStatus.unknown') : text
    }

    function doctorTone(status) {
      if (status === 'pass') return 'ok'
      if (status === 'warn') return 'warn'
      if (status === 'fail') return 'error'
      return 'idle'
    }

    function browserFailureKind(error) {
      if (error !== null && typeof error === 'object' && error.network === true) return 'network'
      if (error?.status === 401 || error?.status === 403) return 'unauthorized'
      if (error?.status === 404) return 'not-found'
      return 'error'
    }

    function isAbort(error) {
      return error !== null && typeof error === 'object' && error.name === 'AbortError'
    }

    function errorDescription(error, t) {
      if (error === null || error === undefined) return ''
      const code = typeof error.code === 'string' ? error.code : ''
      // fishkeeper restore errors carry their own namespace; translate them
      // before the generic status text so a 409 is not just "state conflict".
      if (code.endsWith('restore-stale') || code === 'RESTORE_STALE') return t('fishRestoreStaleBlocked')
      if (code.endsWith('confirm-invalid')) return t('fishRestoreConfirmExpired')
      if (code.endsWith('lock-held')) return t('fishRestoreReadOnlyError')
      if (code.endsWith('restore-unsupported')) return t('fishRestoreUnsupported')
      if (code === 'RESTORE_TOKEN_REJECTED') return t('fishRestoreConfirmExpired')
      const knownKey = code === '' ? '' : `errorCode.${code}`
      const known = knownKey === '' ? '' : t(knownKey)
      const translatedCode = known !== knownKey ? known : ''
      let statusText = ''
      if (error.status === 401) statusText = t('errorUnauthorized')
      else if (error.status === 403) statusText = t('errorForbidden')
      else if (error.status === 404) statusText = t('errorNotFound')
      else if (error.status === 409) statusText = t('errorConflict')
      else if (error.network === true) statusText = t('errorNetwork')
      else if (error.malformed === true) statusText = t('errorMalformed')
      const serverMessage = typeof error.message === 'string' && error.message !== '' && !/^HTTP \d+$/.test(error.message)
        ? error.message
        : ''
      const first = translatedCode !== '' ? translatedCode : statusText
      const parts = [first, serverMessage].filter((part) => typeof part === 'string' && part !== '')
      return parts.length > 0 ? parts.join(' · ') : t('errorGeneric')
    }

    async function requestJson(path, options) {
      let response
      try {
        response = await fetch(`${API}${path}`, options)
      } catch (cause) {
        if (isAbort(cause)) throw cause
        const error = new Error('')
        error.network = true
        throw error
      }
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (response.ok && payload !== null && payload.ok === true) return payload
      const error = new Error(payload !== null && typeof payload.message === 'string' ? payload.message : '')
      error.status = response.status
      error.code = payload !== null && typeof payload.code === 'string'
        ? payload.code
        : (response.ok ? 'MALFORMED_RESPONSE' : `HTTP_${response.status}`)
      if (payload === null) error.malformed = true
      throw error
    }

    function apiGet(path, signal) {
      return requestJson(path, {
        method: 'GET',
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
        signal,
      })
    }

    function apiPost(path, body, token, signal, keepalive = false) {
      return requestJson(path, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'x-overwatch-token': token,
        },
        credentials: 'same-origin',
        body: JSON.stringify(body ?? {}),
        signal,
        ...(keepalive ? { keepalive: true } : {}),
      })
    }

    function httpErrorFromPayload(payload, status, fallbackCode) {
      const nested = payload !== null && typeof payload === 'object'
        && payload.error !== null && typeof payload.error === 'object'
        ? payload.error
        : null
      const code = typeof nested?.code === 'string'
        ? nested.code
        : (typeof payload?.code === 'string' ? payload.code : fallbackCode)
      const message = typeof nested?.message === 'string'
        ? nested.message
        : (typeof payload?.message === 'string' ? payload.message : '')
      const error = new Error(message)
      error.status = status
      error.code = code
      if (payload === null) error.malformed = true
      return error
    }

    // Doctor answers HTTP 200 even when individual checks fail, so its payload
    // must be accepted on transport success instead of requiring `ok: true`.
    async function apiGetRaw(path, signal) {
      let response
      try {
        response = await fetch(`${API}${path}`, {
          method: 'GET',
          headers: { accept: 'application/json' },
          credentials: 'same-origin',
          signal,
        })
      } catch (cause) {
        if (isAbort(cause)) throw cause
        const error = new Error('')
        error.network = true
        throw error
      }
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (!response.ok) throw httpErrorFromPayload(payload, response.status, `HTTP_${response.status}`)
      if (payload === null || typeof payload !== 'object') {
        const error = new Error('')
        error.status = response.status
        error.malformed = true
        throw error
      }
      return payload
    }

    // fishkeeper routes live on the browser-authenticated connection channel,
    // not under /overwatch/api. A 401/404/network failure downgrades the view to
    // the host index; it is never treated as a panel crash.
    async function fishkeeperRequest(path, options) {
      const method = options?.method === 'POST' ? 'POST' : 'GET'
      const signal = options?.signal
      const init = {
        method,
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
        signal,
      }
      if (options?.body !== undefined) {
        init.headers['content-type'] = 'application/json'
        init.body = JSON.stringify(options.body ?? {})
      }
      let response
      try {
        response = await fetch(`/api/fishkeeper${path}`, init)
      } catch (cause) {
        if (isAbort(cause)) throw cause
        const error = new Error('')
        error.network = true
        throw error
      }
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (!response.ok) throw httpErrorFromPayload(payload, response.status, `HTTP_${response.status}`)
      if (payload === null || typeof payload !== 'object') {
        const error = new Error('')
        error.status = response.status
        error.malformed = true
        throw error
      }
      return payload
    }

    function asArray(value) {
      return Array.isArray(value) ? value : []
    }

    function readWriteToken() {
      try {
        if (typeof sessionStorage === 'undefined') return null
        const value = sessionStorage.getItem(TOKEN_KEY)
        return typeof value === 'string' && value !== '' ? value : null
      } catch {
        return null
      }
    }

    function storeWriteToken(value) {
      try {
        if (typeof sessionStorage === 'undefined') return false
        sessionStorage.setItem(TOKEN_KEY, value)
        return true
      } catch {
        return false
      }
    }

    function removeWriteToken() {
      try {
        if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(TOKEN_KEY)
      } catch {
        // Ignore storage failures; the in-memory token is cleared by the caller.
      }
    }

    function usePolling(task, intervalMs, key) {
      const taskRef = useRef(task)
      taskRef.current = task
      useEffect(() => {
        if (key === null || key === undefined) return undefined
        let disposed = false
        let running = false
        let timer = null
        let controller = null
        const tick = async () => {
          if (disposed || running) return
          if (typeof document !== 'undefined' && document.hidden) return
          running = true
          if (controller !== null) controller.abort()
          controller = new AbortController()
          const signal = controller.signal
          try {
            await taskRef.current(signal)
          } catch (error) {
            if (!disposed && !signal.aborted && !isAbort(error)) {
              // Tasks own their error state; unexpected failures are ignored so
              // one bad poll cannot stop the loop.
            }
          } finally {
            running = false
            if (!disposed) timer = setTimeout(tick, intervalMs)
          }
        }
        const onVisibility = () => {
          if (typeof document === 'undefined') return
          if (document.hidden) {
            clearTimeout(timer)
            if (controller !== null) controller.abort()
            return
          }
          clearTimeout(timer)
          if (!running) tick()
        }
        tick()
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)
        return () => {
          disposed = true
          clearTimeout(timer)
          if (controller !== null) controller.abort()
          if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility)
        }
      }, [intervalMs, key])
    }

    function mergeEvents(existing, batch) {
      const byKey = new Map()
      for (const event of existing) byKey.set(eventKey(event), event)
      for (const event of batch) byKey.set(eventKey(event), event)
      // The server already returns the merged timeline in display order
      // (at, then source rank, then seq); preserve that order instead of
      // re-sorting by per-source seq.
      return Array.from(byKey.values())
    }

    function eventKey(event) {
      if (event !== null && event !== undefined && event.seq !== null && event.seq !== undefined) {
        // A merged timeline can carry the same per-source seq for different
        // sources; include the source, type, and timestamp so React keys stay
        // unique without re-ordering the server sequence.
        return `seq:${event.seq}:${event?.source ?? ''}:${event?.type ?? ''}:${event?.at ?? ''}`
      }
      return `x:${event?.source ?? ''}:${event?.type ?? ''}:${event?.at ?? ''}:${event?.summary ?? ''}`
    }

    const WATCH_EVENT_TYPES = /^(watch|case|action|decision|signal|guard)/i

    function isWatchEvent(event) {
      const type = typeof event?.type === 'string' ? event.type : ''
      if (WATCH_EVENT_TYPES.test(type)) return true
      return typeof event?.source === 'string' && event.source.toLowerCase() === 'watch'
    }

    function freshnessState(freshness) {
      if (freshness === null || freshness === undefined) return 'unavailable'
      const declared = typeof freshness.state === 'string' ? freshness.state.toLowerCase() : ''
      if (declared === 'ok' || declared === 'stale' || declared === 'unavailable') return declared
      if (freshness.ok !== true) return 'unavailable'
      if (freshness.stale === true) return 'stale'
      if (typeof freshness.ageMs === 'number' && Number.isFinite(freshness.ageMs) && freshness.ageMs > STALE_MS) return 'stale'
      return 'ok'
    }

    const ENDED_RUN_STATES = new Set(['disarmed', 'closed', 'ended', 'stopped', 'archived'])

    const TAB_ORDER = ['room', 'cases', 'fish', 'replay']
    const TAB_LABEL_KEYS = {
      room: 'tabRoom',
      cases: 'tabCases',
      fish: 'tabFish',
      replay: 'tabReplay',
    }

    function groupRuns(runs) {
      const armed = []
      const disarmed = []
      const history = []
      for (const run of runs) {
        if (run?.armed === true) armed.push(run)
        else if (ENDED_RUN_STATES.has(String(run?.state ?? '').toLowerCase())) disarmed.push(run)
        else history.push(run)
      }
      const byUpdated = (a, b) => {
        const left = hasTime(a?.updatedAt) ? Date.parse(a.updatedAt) : 0
        const right = hasTime(b?.updatedAt) ? Date.parse(b.updatedAt) : 0
        return right - left
      }
      armed.sort(byUpdated)
      disarmed.sort(byUpdated)
      history.sort(byUpdated)
      return [
        { key: 'armed', labelKey: 'groupArmed', runs: armed },
        { key: 'disarmed', labelKey: 'groupDisarmed', runs: disarmed },
        { key: 'history', labelKey: 'groupHistory', runs: history },
      ]
    }

    function navIcon(props) {
      const size = typeof props?.size === 'number' ? props.size : 18
      const color = props?.active ? 'var(--dsw-alias-brand-primary)' : 'currentColor'
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: color,
        strokeWidth: 1.6,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        focusable: 'false',
        style: { display: 'block' },
      },
        h('path', { d: 'M4 21h16' }),
        h('path', { d: 'M6.5 21 9.5 8.5h5L17.5 21' }),
        h('path', { d: 'M8.5 8.5h7' }),
        h('path', { d: 'M9 4h6l2 4.5H7L9 4Z' }),
        h('circle', { cx: 12, cy: 13, r: 1.7 }),
        h('path', { d: 'M12 11.3V14.7' }),
      )
    }

    function Badge({ tone = 'idle', children, title }) {
      return h('span', { className: `ow-badge ow-badge-${tone}`, title }, children)
    }

    function Kpi(label, value, hint) {
      return h('div', { className: 'ow-kpi' },
        h('span', { className: 'ow-kpi-label' }, label),
        h('span', { className: 'ow-kpi-value' }, value),
        hint ? h('span', { className: 'ow-kpi-hint' }, hint) : null,
      )
    }

    function ErrorNotice({ error, title, onRetry, t }) {
      if (error === null || error === undefined) return null
      return h('div', { className: 'ow-error', role: 'alert' },
        h('strong', null, title ?? t('errorTitle')),
        h('span', { className: 'ow-error-text' }, errorDescription(error, t)),
        typeof error.code === 'string' && error.code !== '' ? h('code', { className: 'ow-code' }, error.code) : null,
        typeof onRetry === 'function'
          ? h('button', { type: 'button', className: 'ow-btn ow-btn-small', onClick: onRetry }, t('retry'))
          : null,
      )
    }

    function BudgetBar({ budget, t }) {
      const limit = typeof budget?.limit === 'number' && Number.isFinite(budget.limit) ? budget.limit : null
      const spent = typeof budget?.spent === 'number' && Number.isFinite(budget.spent) ? budget.spent : null
      let ratio = typeof budget?.ratio === 'number' && Number.isFinite(budget.ratio) ? budget.ratio : null
      if (ratio === null && limit !== null && limit > 0 && spent !== null) ratio = spent / limit
      const percent = ratio === null ? null : Math.max(0, Math.min(100, ratio * 100))
      const tone = ratio === null ? 'idle' : ratio >= 0.95 ? 'danger' : ratio >= 0.8 ? 'warn' : 'ok'
      const toneText = ratio === null
        ? t('budgetUnknown')
        : ratio >= 0.95
          ? t('budgetOver')
          : ratio >= 0.8
            ? t('budgetAtWarn')
            : t('budgetOk')
      const numbers = limit !== null && limit > 0
        ? t('budgetUsed', {
            spent: spent === null ? '—' : formatNumber(spent),
            limit: formatNumber(limit),
          })
        : t('budgetUnlimited')
      const valueText = ratio === null
        ? t('budgetUnknown')
        : t('budgetPercent', { percent: formatPercent(ratio) })
      return h('div', { className: 'ow-budget' },
        h('div', { className: 'ow-budget-head' },
          h('span', { className: 'ow-budget-label' }, t('budget')),
          h('span', { className: 'ow-budget-numbers' }, numbers),
        ),
        h('div', {
          className: 'ow-budget-track',
          role: 'progressbar',
          'aria-label': t('budget'),
          'aria-valuemin': 0,
          'aria-valuemax': 100,
          'aria-valuenow': percent === null ? 0 : Math.round(percent),
          'aria-valuetext': valueText,
        },
          h('div', {
            className: `ow-budget-fill ow-budget-fill-${tone}`,
            style: { width: `${percent === null ? 0 : percent}%` },
          }),
          h('span', { className: 'ow-budget-tick ow-budget-tick-80', 'aria-hidden': true }),
          h('span', { className: 'ow-budget-tick ow-budget-tick-95', 'aria-hidden': true }),
        ),
        h('div', { className: 'ow-budget-foot' },
          h('span', { className: `ow-tone-${tone}` }, toneText),
          typeof budget?.reserve === 'number' && Number.isFinite(budget.reserve)
            ? h('span', { className: 'ow-muted' }, t('budgetReserve', { reserve: formatNumber(budget.reserve) }))
            : null,
        ),
        h('p', { className: 'ow-budget-scale' }, t('budgetThresholds')),
      )
    }

    function FreshnessChips({ freshness, t }) {
      const sources = [
        { key: 'swarm', labelKey: 'source.swarm' },
        { key: 'pressure', labelKey: 'source.pressure' },
        { key: 'fish', labelKey: 'source.fish' },
      ]
      return h('div', { className: 'ow-freshness' },
        h('h3', null, t('freshness')),
        h('div', { className: 'ow-chips', role: 'list', 'aria-label': t('freshness') },
          sources.map((source) => {
            const entry = freshness?.[source.key]
            const state = freshnessState(entry)
            const age = typeof entry?.ageMs === 'number' && Number.isFinite(entry.ageMs)
              ? t('fresh.age', { age: formatAgo(entry.ageMs) })
              : ''
            const error = typeof entry?.error === 'string' && entry.error !== ''
              ? t('fresh.error', { message: entry.error })
              : ''
            const label = [t(source.labelKey), t(`fresh.${state}`), age, error].filter((part) => part !== '').join(' · ')
            return h('div', {
              key: source.key,
              className: `ow-chip ow-chip-${state}`,
              role: 'listitem',
              title: label,
              'aria-label': label,
            },
              h('span', { className: 'ow-chip-dot', 'aria-hidden': true }),
              h('span', { className: 'ow-chip-source' }, t(source.labelKey)),
              h('span', { className: 'ow-chip-state' }, t(`fresh.${state}`)),
              age !== '' ? h('span', { className: 'ow-chip-meta' }, age) : null,
            )
          }),
        ),
      )
    }

    function SeverityCounts({ cases, available, t }) {
      const bySeverity = cases?.bySeverity ?? {}
      return h('div', { className: 'ow-sev-grid', role: 'list', 'aria-label': t('casesBySeverity') },
        ['L1', 'L2', 'L3', 'L4'].map((severity) => {
          const count = available && typeof bySeverity[severity] === 'number' ? formatNumber(bySeverity[severity]) : '—'
          return h('div', {
            key: severity,
            className: `ow-sev ow-sev-${severity.toLowerCase()}`,
            role: 'listitem',
            'aria-label': `${severity} ${t(`severity.meaning.${severity}`)}: ${count}`,
          },
            h('span', { className: 'ow-sev-code' }, severity),
            h('strong', { className: 'ow-sev-count' }, count),
            h('span', { className: 'ow-sev-meaning' }, t(`severity.meaning.${severity}`)),
          )
        }),
      )
    }

    function RunList({ runs, selectedRunId, onSelect, t }) {
      const groups = groupRuns(runs)
      return h('section', { className: 'ow-card ow-runlist', 'aria-label': t('runs') },
        h('div', { className: 'ow-card-head' },
          h('h2', null, t('runs')),
          h('span', { className: 'ow-muted ow-small' }, t('runCount', { count: formatNumber(runs.length) })),
        ),
        h('div', { className: 'ow-run-groups' },
          groups.filter((group) => group.runs.length > 0).map((group) => h('div', { key: group.key, className: 'ow-run-group' },
            h('h3', { className: 'ow-group-title' },
              h('span', null, t(group.labelKey)),
              h('span', null, formatNumber(group.runs.length)),
            ),
            h('ul', { className: 'ow-run-list' },
              group.runs.map((run) => {
                const selected = String(selectedRunId) === String(run.runId)
                const ratio = typeof run?.budget?.ratio === 'number' && Number.isFinite(run.budget.ratio) ? run.budget.ratio : null
                const runStateLabel = run.state
                  ? translateCode(t, 'runState', run.state)
                  : (run.armed === true ? t('groupArmed') : t('groupDisarmed'))
                const runTone = run.state === 'failed'
                  ? 'error'
                  : run.state === 'degraded'
                    ? 'warn'
                    : run.armed === true
                      ? 'ok'
                      : 'idle'
                return h('li', { key: String(run.runId) },
                  h('button', {
                    type: 'button',
                    className: 'ow-run',
                    'aria-pressed': selected,
                    'aria-label': `${run.runId} · ${runStateLabel} · ${run.goal ?? ''}`,
                    onClick: () => onSelect(String(run.runId)),
                  },
                    h('span', { className: 'ow-run-id' }, run.runId),
                    h('span', { className: 'ow-run-goal' }, run.goal ?? t('goalEmpty')),
                    h('span', { className: 'ow-run-meta' },
                      h(Badge, { tone: runTone }, runStateLabel),
                      h('span', { className: 'ow-run-mode' }, translateCode(t, 'mode', run.mode)),
                      typeof run.openCases === 'number' && run.openCases > 0
                        ? h('span', { className: 'ow-run-cases' }, t('casesOpenCount', { count: formatNumber(run.openCases) }))
                        : null,
                      ratio !== null ? h('span', { className: 'ow-run-budget' }, formatPercent(ratio)) : null,
                    ),
                    h('span', { className: 'ow-run-time', title: formatTime(run.updatedAt) }, formatRelative(run.updatedAt)),
                  ),
                )
              }),
            ),
          )),
        ),
      )
    }

    function SnapshotStats({ snapshot, t }) {
      if (snapshot === null || snapshot === undefined) return null
      const tasks = snapshot.tasks ?? {}
      const reviews = snapshot.reviews ?? {}
      const merge = snapshot.merge ?? {}
      const members = Array.isArray(snapshot.members) ? snapshot.members.length : null
      const stats = [
        { key: 'taskQueued', value: tasks.queued },
        { key: 'taskWorking', value: tasks.working },
        { key: 'taskReviewing', value: tasks.reviewing },
        { key: 'taskApproved', value: tasks.approved },
        { key: 'taskBlocked', value: tasks.blocked },
        { key: 'taskMerged', value: tasks.merged },
        { key: 'reviewsOpen', value: reviews.open },
        { key: 'reviewsOldest', value: typeof reviews.oldestMs === 'number' ? formatDuration(reviews.oldestMs) : null },
        { key: 'mergeQueue', value: merge.queue },
        { key: 'mergeConflicts', value: merge.conflicts },
        { key: 'membersCount', value: members },
      ]
      return h('div', { className: 'ow-snapshot', 'aria-label': t('tasks') },
        h('h3', null, t('tasks')),
        h('div', { className: 'ow-stats' },
          stats.map((stat) => h('div', { key: stat.key, className: 'ow-stat' },
            h('span', { className: 'ow-stat-label' }, t(stat.key)),
            h('span', { className: 'ow-stat-value' }, typeof stat.value === 'number' ? formatNumber(stat.value) : (stat.value ?? '—')),
          )),
        ),
      )
    }

    function RunOverview({ run, detail, error, onOpenCases, onRetry, t }) {
      const data = detail ?? run ?? {}
      const snapshot = detail?.snapshot ?? null
      const armed = detail?.armed ?? run?.armed ?? false
      const stateLabel = data.state
        ? translateCode(t, 'runState', data.state)
        : (armed ? t('groupArmed') : t('groupDisarmed'))
      const stateTone = data.state === 'failed'
        ? 'error'
        : data.state === 'degraded'
          ? 'warn'
          : armed
            ? 'ok'
            : 'idle'
      const openCases = detail?.cases?.open ?? run?.openCases
      const casesAvailable = detail !== null && detail !== undefined && detail.cases !== null && detail.cases !== undefined
      return h('section', { className: 'ow-card ow-overview', 'aria-label': t('overview') },
        h('div', { className: 'ow-overview-head' },
          h('div', { className: 'ow-overview-title' },
            h('h2', { className: 'ow-mono', title: String(run?.runId ?? '') }, run?.runId ?? '—'),
            h('p', { className: 'ow-goal' }, data.goal || run?.goal || t('goalEmpty')),
          ),
          h('div', { className: 'ow-overview-badges' },
            h(Badge, { tone: stateTone }, stateLabel),
            h(Badge, { tone: data.mode === 'guard' || data.mode === 'supervised' ? 'brand' : 'idle' }, translateCode(t, 'mode', data.mode)),
            h(Badge, { tone: data.status === 'error' ? 'error' : data.status === 'paused' ? 'warn' : 'idle' }, translateCode(t, 'runState', data.status)),
          ),
        ),
        h(ErrorNotice, { error, title: t('runDetailUnavailable'), onRetry, t }),
        h('div', { className: 'ow-kpis' },
          Kpi(t('state'), stateLabel),
          Kpi(t('mode'), translateCode(t, 'mode', data.mode)),
          Kpi(t('status'), translateCode(t, 'runState', data.status)),
          Kpi(t('round'), snapshot !== null && typeof snapshot.round === 'number' ? formatNumber(snapshot.round) : '—'),
          Kpi(t('lastEventAt'), formatTime(detail?.lastEventAt ?? snapshot?.lastEventAt ?? run?.updatedAt)),
        ),
        h('div', { className: 'ow-overview-grid' },
          h('div', { className: 'ow-overview-col' },
            h(BudgetBar, { budget: detail?.budget ?? run?.budget, t }),
            freshnessBlock(detail, t),
            h(SnapshotStats, { snapshot, t }),
          ),
          h('div', { className: 'ow-overview-col' },
            h('div', { className: 'ow-subcard' },
              h('div', { className: 'ow-card-head' },
                h('h3', null, t('casesOpen')),
                h('span', { className: 'ow-muted ow-small' }, typeof openCases === 'number' ? t('casesOpenCount', { count: formatNumber(openCases) }) : '—'),
              ),
              h(SeverityCounts, { cases: detail?.cases, available: casesAvailable, t }),
              h('button', {
                type: 'button',
                className: 'ow-btn ow-btn-small',
                onClick: onOpenCases,
              }, t('viewCases')),
            ),
            h('dl', { className: 'ow-dl ow-times' },
              dtDd(t('armedAt'), formatTime(detail?.armedAt)),
              dtDd(t('disarmedAt'), formatTime(detail?.disarmedAt)),
              dtDd(t('lastEventAt'), formatTime(detail?.lastEventAt)),
            ),
            watchBlock(detail, t),
          ),
        ),
      )
    }

    function freshnessBlock(detail, t) {
      if (detail === null || detail === undefined) {
        return h('div', { className: 'ow-freshness' },
          h('h3', null, t('freshness')),
          h('p', { className: 'ow-muted ow-small' }, t('fresh.noData')),
        )
      }
      return h(FreshnessChips, { freshness: detail.freshness, t })
    }

    function watchBlock(detail, t) {
      const watch = detail?.watch ?? null
      if (watch === null) return null
      const state = typeof watch.state === 'string' && watch.state !== ''
        ? watch.state
        : watch.enabled === true ? 'absent' : 'disabled'
      const tone = state === 'failed'
        ? 'error'
        : state === 'waking' || state === 'starting'
          ? 'warn'
          : watch.enabled === true ? 'ok' : 'muted'
      return h('div', { className: 'ow-subcard' },
        h('div', { className: 'ow-card-head' },
          h('h3', null, t('watchOfficer')),
          h(Badge, { tone }, watchStateLabel(t, state)),
        ),
        watch.enabled === true
          ? h('dl', { className: 'ow-dl' },
              dtDd(t('watchWakes'), formatNumber(watch.wakes ?? 0)),
              dtDd(t('watchTimeouts'), formatNumber(watch.timeouts ?? 0)),
              dtDd(t('watchTokens'), `${formatNumber(watch.spent ?? 0)} / ${formatNumber(watch.reserve ?? 0)}`),
              dtDd(t('watchChild'), watch.childId ? `${String(watch.childId).slice(0, 8)}…${String(watch.childId).slice(-4)}` : '—'),
            )
          : h('p', { className: 'ow-muted ow-small' }, t('watchDisabled')),
      )
    }

    function IntegrityCard({ health, detail, error, selectedRunId, doctor, doctorError, doctorReady, onRetry, t }) {
      const runHealth = selectedRunId === null
        ? null
        : asArray(health?.runs).find((entry) => String(entry?.runId) === String(selectedRunId)) ?? null
      const watch = runHealth?.log ?? detail?.chain ?? health?.service?.watch ?? health?.watch ?? null
      const count = watch !== null && typeof watch.count === 'number'
        ? watch.count
        : watch !== null && typeof watch.events === 'number'
          ? watch.events
          : null
      const chainOk = watch !== null && watch.ok === true
      const chainLabel = watch === null ? t('notReported') : chainOk ? t('watchLogOk') : t('watchLogBad')
      const chainTone = watch === null ? 'muted' : chainOk ? 'ok' : 'error'
      const chainError = typeof watch?.error === 'string' && watch.error !== '' ? watch.error : null
      const lock = runHealth?.lock ?? detail?.lock ?? health?.service?.lock ?? health?.lock ?? null
      let lockLabel = t('lockNotReported')
      let lockTone = 'muted'
      if (lock !== null && lock !== undefined) {
        if (lock.ok === true || lock.held === true) {
          lockLabel = t('lockHeld')
          lockTone = 'ok'
        } else if (lock.held === false) {
          lockLabel = t('lockNotHeld')
          lockTone = 'muted'
        } else if (lock.ok === false) {
          lockLabel = t('lockLost')
          lockTone = 'error'
        } else {
          lockLabel = t('notProvided')
        }
      }
      return h('section', { className: 'ow-card ow-integrity', 'aria-label': t('integrity') },
        h('h2', null, t('integrity')),
        h(ErrorNotice, { error, title: t('integrity'), onRetry, t }),
        h('dl', { className: 'ow-dl' },
          dtDd(t('watchLog'), h('span', { className: `ow-tone-${chainTone}` },
            chainLabel,
            count !== null ? ` · ${t('watchLogCount', { count: formatNumber(count) })}` : '',
            chainError !== null ? ` · ${chainError}` : '',
          )),
          dtDd(t('lockState'), h('span', { className: `ow-tone-${lockTone}` }, lockLabel)),
          dtDd(t('serviceVersion'), health?.version ?? '—'),
          dtDd(t('serviceMode'), health?.mode ? translateCode(t, 'mode', health.mode) : '—'),
          dtDd(t('dataDir'), health?.dataDir ?? '—'),
        ),
        h(DoctorChecks, {
          doctor,
          error: doctorError,
          ready: doctorReady,
          onRetry,
          t,
        }),
      )
    }

    // Doctor checks live in their own poll and are rendered as a nested card so
    // a slow or failing /doctor request never delays the run overview.
    function DoctorChecks({ doctor, error, ready, onRetry, t }) {
      const checks = asArray(doctor?.checks)
      const overall = error !== null && error !== undefined
        ? 'fail'
        : !ready || checks.length === 0
          ? 'unknown'
          : checks.some((check) => check?.status === 'fail')
            ? 'fail'
            : checks.some((check) => check?.status === 'warn')
              ? 'warn'
              : 'ok'
      const overallKey = overall === 'ok'
        ? 'doctorOverallOk'
        : overall === 'warn'
          ? 'doctorOverallWarn'
          : overall === 'fail'
            ? 'doctorOverallFail'
            : 'doctorOverallUnknown'
      const tone = overall === 'ok' ? 'ok' : overall === 'warn' ? 'warn' : overall === 'fail' ? 'error' : 'idle'
      return h('div', { className: 'ow-doctor', 'aria-label': t('doctorTitle') },
        h('div', { className: 'ow-card-head' },
          h('div', null,
            h('h3', null, t('doctorTitle')),
            h('p', { className: 'ow-muted ow-small' }, t('doctorSubtitle')),
          ),
          h('div', { className: 'ow-actions-row' },
            h(Badge, { tone }, t(overallKey)),
            h('button', { type: 'button', className: 'ow-btn ow-btn-small', onClick: onRetry }, t('retry')),
          ),
        ),
        h(ErrorNotice, { error, title: t('doctorError'), onRetry, t }),
        !ready && (error === null || error === undefined) ? h('p', { className: 'ow-muted ow-small' }, t('doctorLoading')) : null,
        ready && checks.length === 0 && (error === null || error === undefined)
          ? h('p', { className: 'ow-muted ow-small' }, t('doctorEmpty'))
          : null,
        checks.length > 0
          ? h('div', { className: 'ow-table-wrap' },
              h('table', { className: 'ow-table ow-doctor-table' },
                h('caption', { className: 'ow-sr' }, t('doctorTitle')),
                h('thead', null, h('tr', null,
                  h('th', { scope: 'col' }, t('doctorCheck')),
                  h('th', { scope: 'col' }, t('doctorStatusCol')),
                  h('th', { scope: 'col' }, t('doctorDetailCol')),
                )),
                h('tbody', null, checks.map((check, index) => h('tr', { key: `${check?.id ?? 'check'}:${index}` },
                  h('td', null, h('code', { className: 'ow-code' }, check?.id ?? '—')),
                  h('td', null, h(Badge, { tone: doctorTone(check?.status) }, doctorStatusLabel(t, check?.status))),
                  h('td', { className: 'ow-cell-summary' }, summarizeDetail(check?.detail, t)),
                ))),
              ),
            )
          : null,
      )
    }

    function dtDd(term, description) {
      return h('div', { className: 'ow-dl-row' },
        h('dt', null, term),
        h('dd', null, description),
      )
    }

    function RecentEvents({ events, error, onRetry, t }) {
      const watchEvents = events.filter(isWatchEvent).slice(-10).reverse()
      return h('section', { className: 'ow-card ow-events', 'aria-label': t('recentEvents') },
        h('div', { className: 'ow-card-head' },
          h('h2', null, t('recentEvents')),
          h('span', { className: 'ow-muted ow-small' }, t('recentEventsHint')),
        ),
        h(ErrorNotice, { error, title: t('recentEvents'), onRetry, t }),
        watchEvents.length === 0
          ? (error !== null ? null : h('p', { className: 'ow-muted' }, t('noEvents')))
          : h('div', { className: 'ow-table-wrap' },
              h('table', { className: 'ow-table' },
                h('caption', { className: 'ow-sr' }, t('recentEvents')),
                h('thead', null, h('tr', null,
                  h('th', { scope: 'col' }, t('eventSeq')),
                  h('th', { scope: 'col' }, t('eventTime')),
                  h('th', { scope: 'col' }, t('eventType')),
                  h('th', { scope: 'col' }, t('eventActor')),
                  h('th', { scope: 'col' }, t('eventSummary')),
                )),
                h('tbody', null, watchEvents.map((event) => h('tr', { key: eventKey(event) },
                  h('td', { className: 'ow-cell-seq' }, typeof event.seq === 'number' ? formatNumber(event.seq) : (event.seq ?? '—')),
                  h('td', { className: 'ow-cell-time', title: hasTime(event.at) ? undefined : t('unknownTime') },
                    hasTime(event.at) ? formatTime(event.at) : h('span', { className: 'ow-muted' }, t('unknownTime'))),
                  h('td', null, h('code', { className: 'ow-code' }, event.type ?? '—')),
                  h('td', null, event.actor ?? '—'),
                  h('td', { className: 'ow-cell-summary' }, event.summary ?? '—'),
                ))),
              ),
            ),
      )
    }

    function browserFailureText(t, state) {
      const kind = state?.kind
      if (kind === 'unauthorized') return t('fishBrowserUnauthorized')
      if (kind === 'not-found') return t('fishBrowserNotFound')
      if (kind === 'network') return t('fishBrowserNetwork')
      const message = typeof state?.message === 'string' && state.message !== '' ? state.message : t('errorGeneric')
      return t('fishBrowserError', { message })
    }

    function mergeCheckpoints(hostList, browserList) {
      const byId = new Map()
      for (const item of asArray(hostList)) {
        if (item === null || typeof item !== 'object' || typeof item.id !== 'string') continue
        byId.set(item.id, { ...item, fromHost: true })
      }
      for (const item of asArray(browserList)) {
        if (item === null || typeof item !== 'object' || typeof item.id !== 'string') continue
        const existing = byId.get(item.id) ?? {}
        byId.set(item.id, { ...existing, ...item, fromHost: existing.fromHost === true, fromBrowser: true })
      }
      return Array.from(byId.values()).sort((left, right) => String(right.createdAt ?? '').localeCompare(String(left.createdAt ?? '')))
    }

    function sourceChip(t, source) {
      const label = sourceLabel(t, source)
      const slug = typeof source === 'string' ? source.toLowerCase().replace(/[^a-z0-9_-]/g, '') : 'unknown'
      return h('span', {
        className: `ow-source-chip ow-source-${slug}`,
        title: label,
        'aria-label': label,
      },
        h('span', { className: 'ow-source-dot', 'aria-hidden': true }),
        h('span', null, label),
      )
    }

    function FishView({ model, restoreBusy, onSelectSource, onRestore, onRetry, t }) {
      const index = model.index
      const indexErrors = asArray(index?.errors)
      const sourceErrors = sourceIdFilter(indexErrors, model.sourceId)
      const hostSource = model.hostSource
      const browserSource = model.browserSource
      const overview = model.overview ?? { state: 'unknown' }
      const checkpointsState = model.checkpointsState ?? { state: 'idle' }
      const rows = asArray(model.checkpoints)
      const audit = asArray(hostSource?.audit)
      const indexTone = model.hostError !== null && model.hostError !== undefined
        ? 'error'
        : !model.ready
          ? 'idle'
          : index !== null && index !== undefined && index.available === false
            ? 'warn'
            : indexErrors.length > 0 ? 'warn' : 'ok'
      const indexLabel = model.hostError !== null && model.hostError !== undefined
        ? t('fishIndexUnavailable')
        : !model.ready
          ? t('loading')
          : index !== null && index !== undefined && index.available === false
            ? t('fishIndexUnavailable')
            : indexErrors.length > 0 ? t('fishIndexPartial') : t('fishIndexAvailable')
      const browserTone = (overview.state === 'unavailable' || checkpointsState.state === 'error')
        ? 'warn'
        : overview.state === 'available' ? 'ok' : 'idle'
      const browserFailure = overview.state === 'unavailable'
        ? overview
        : checkpointsState.state === 'error' ? checkpointsState : null
      const browserLabel = browserFailure !== null
        ? t('fishBrowserIndexOnly')
        : overview.state === 'available' ? t('fishBrowserAvailable') : t('fishBrowserChecking')
      const restoreCapable = checkpointsState.state === 'available'
        && checkpointsState.data?.restoreSupported === true
        && checkpointsState.data?.readOnly !== true
      return h('div', { className: 'ow-fish' },
        h('section', { className: 'ow-card ow-fish-host', 'aria-label': t('fishHostIndex') },
          h('div', { className: 'ow-card-head' },
            h('div', null,
              h('h2', null, t('fishTitle')),
              h('p', { className: 'ow-muted ow-small ow-subtitle' }, t('fishSubtitle')),
            ),
            h('div', { className: 'ow-actions-row' },
              h(Badge, { tone: indexTone }, indexLabel),
              h('button', { type: 'button', className: 'ow-btn ow-btn-small', onClick: onRetry }, t('refresh')),
            ),
          ),
          h(ErrorNotice, { error: model.hostError, title: t('fishIndexUnavailable'), onRetry, t }),
          !model.ready && (model.hostError === null || model.hostError === undefined)
            ? h('p', { className: 'ow-muted' }, t('loading'))
            : null,
          index !== null && index !== undefined
            ? h('div', null,
                h('h3', null, t('fishHostIndex')),
                h('p', { className: 'ow-muted ow-small' }, t('fishHostHint')),
                h('dl', { className: 'ow-dl' },
                  dtDd(t('fishDataDir'), index.dataDir ?? '—'),
                  dtDd(t('asOf'), formatTime(index.asOf ?? model.asOf)),
                ),
                index.available === false
                  ? h('p', { className: 'ow-tone-warn' },
                      t('fishIndexMissing', { path: index.dataDir ?? '—' }),
                      ' ',
                      t('fishIndexMissingHint'),
                    )
                  : null,
                indexErrors.length > 0
                  ? h('div', { className: 'ow-fish-errors', role: 'alert' },
                      h('h3', null, t('fishIndexErrors')),
                      h('ul', null, indexErrors.map((error, position) => h('li', { key: `${error?.sourceId ?? ''}:${error?.code ?? ''}:${position}` },
                        error?.sourceId ? h('code', { className: 'ow-code' }, error.sourceId) : null,
                        h('code', { className: 'ow-code' }, error?.code ?? '—'),
                        h('span', null, error?.message ?? ''),
                      ))),
                    )
                  : null,
              )
            : null,
        ),
        h('section', { className: 'ow-card ow-fish-browser', 'aria-label': t('fishBrowser') },
          h('div', { className: 'ow-card-head' },
            h('div', null,
              h('h2', null, t('fishBrowser')),
              h('p', { className: 'ow-muted ow-small ow-subtitle' },
                browserFailure !== null ? t('fishBrowserUnavailableHint') : t('fishBrowserAvailableHint')),
            ),
            h(Badge, { tone: browserTone }, browserLabel),
          ),
          browserFailure !== null
            ? h('div', { className: 'ow-fish-degraded', role: 'status' },
                h('strong', null, t('fishBrowserIndexOnly')),
                h('p', null, browserFailureText(t, browserFailure)),
              )
            : null,
          overview.state === 'unknown'
            ? h('p', { className: 'ow-muted' }, t('fishBrowserChecking'))
            : null,
          overview.state === 'available'
            ? h('div', null,
                h('dl', { className: 'ow-dl' },
                  dtDd(t('fishBrowserMode'), overview.data?.mode ?? '—'),
                  dtDd(t('asOf'), formatTime(overview.data?.generatedAt)),
                ),
                browserSource !== null && browserSource !== undefined
                  ? h('dl', { className: 'ow-dl' },
                      dtDd(t('fishSource'), browserSource.displayName ?? browserSource.id ?? model.sourceId ?? '—'),
                      dtDd(t('fishBrowserSourceStatus'), h('span', { className: browserSource.status === 'error' ? 'ow-tone-error' : 'ow-tone-ok' },
                        browserSource.status === 'ok' ? t('fresh.ok') : translateCode(t, 'runState', browserSource.status),
                        browserSource.readOnly === true ? ` · ${t('fishBrowserReadOnly')}` : '',
                      )),
                    )
                  : null,
                checkpointsState.state === 'available'
                  ? h('p', { className: restoreCapable ? 'ow-tone-ok' : 'ow-tone-warn' },
                      restoreCapable ? t('fishRestoreSupported') : t('fishRestoreUnsupported'))
                  : null,
              )
            : null,
        ),
        model.sourceIds.length === 0
          ? h('section', { className: 'ow-card ow-state' }, t('fishNoSources'))
          : h('section', { className: 'ow-card ow-fish-source', 'aria-label': t('fishSource') },
              h('div', { className: 'ow-card-head' },
                h('div', null,
                  h('h2', { className: 'ow-mono' }, model.sourceId ?? t('fishSource')),
                  browserSource !== null && browserSource !== undefined && browserSource.displayName
                    ? h('p', { className: 'ow-muted ow-small' }, browserSource.displayName)
                    : null,
                ),
                h('div', { className: 'ow-source-picker', role: 'group', 'aria-label': t('fishSources') },
                  model.sourceIds.map((id) => h('button', {
                    key: id,
                    type: 'button',
                    className: 'ow-btn ow-btn-small',
                    'aria-pressed': id === model.sourceId,
                    onClick: () => onSelectSource(id),
                  }, id)),
                ),
              ),
              hostSource === null || hostSource === undefined
                ? h('p', { className: 'ow-muted ow-small' }, t('fishNoHostSource'))
                : null,
              sourceErrors.length > 0
                ? h('ul', { className: 'ow-fish-errors', role: 'alert' },
                    sourceErrors.map((error, position) => h('li', { key: `${error?.code ?? ''}:${position}` },
                      h('code', { className: 'ow-code' }, error?.code ?? '—'),
                      h('span', null, error?.message ?? ''),
                    )),
                  )
                : null,
              h('p', {
                className: model.restoreDisabledReason === null ? 'ow-hint' : 'ow-hint ow-tone-warn',
                role: 'status',
              }, model.restoreDisabledReason === null ? t('fishRestoreReady') : t(model.restoreDisabledReason)),
              h('h3', null, t('fishCheckpoints')),
              rows.length === 0
                ? h('p', { className: 'ow-muted' }, t('fishNoCheckpoints'))
                : h('div', { className: 'ow-table-wrap' },
                    h('table', { className: 'ow-table ow-fish-checkpoints' },
                      h('caption', { className: 'ow-sr' }, `${t('fishCheckpoints')} · ${model.sourceId ?? ''}`),
                      h('thead', null, h('tr', null,
                        h('th', { scope: 'col' }, t('fishTrigger')),
                        h('th', { scope: 'col' }, t('fishAuditAt')),
                        h('th', { scope: 'col' }, t('fishFiles')),
                        h('th', { scope: 'col' }, t('fishStoredBytes')),
                        h('th', { scope: 'col' }, t('fishPinned')),
                        h('th', { scope: 'col' }, t('fishRestoreAction')),
                      )),
                      h('tbody', null, rows.map((checkpoint) => {
                        const disabled = model.restoreDisabledReason !== null || restoreBusy
                        return h('tr', { key: checkpoint.id },
                          h('td', null,
                            h(Badge, { tone: 'idle' }, triggerLabel(t, checkpoint.trigger)),
                            checkpoint.baseline === true ? h(Badge, { tone: 'brand' }, t('fishBaseline')) : null,
                          ),
                          h('td', { className: 'ow-cell-time' }, formatTime(checkpoint.createdAt)),
                          h('td', null, typeof checkpoint.files === 'number' ? formatNumber(checkpoint.files) : '—'),
                          h('td', null, formatBytes(checkpoint.storedBytes)),
                          h('td', null, checkpoint.pinned === true
                            ? h(Badge, { tone: 'ok' }, t('fishPinned'))
                            : h('span', { className: 'ow-muted ow-small' }, t('fishNotPinned'))),
                          h('td', null, h('button', {
                            type: 'button',
                            className: 'ow-btn ow-btn-small',
                            disabled,
                            title: model.restoreDisabledReason === null ? t('fishRestoreAction') : t(model.restoreDisabledReason),
                            'aria-label': `${t('fishRestoreAction')} ${checkpoint.id}`,
                            'aria-disabled': disabled,
                            onClick: () => onRestore(model.sourceId, checkpoint.id),
                          }, t('fishRestoreAction'))),
                        )
                      })),
                    ),
                  ),
              h('h3', null, t('fishAudit')),
              audit.length === 0
                ? h('p', { className: 'ow-muted' }, t('fishNoAudit'))
                : h('div', { className: 'ow-table-wrap' },
                    h('table', { className: 'ow-table ow-fish-audit' },
                      h('caption', { className: 'ow-sr' }, `${t('fishAudit')} · ${model.sourceId ?? ''}`),
                      h('thead', null, h('tr', null,
                        h('th', { scope: 'col' }, t('fishAuditAt')),
                        h('th', { scope: 'col' }, t('fishAuditAction')),
                        h('th', { scope: 'col' }, t('fishAuditCheckpoint')),
                        h('th', { scope: 'col' }, t('fishAuditResult')),
                        h('th', { scope: 'col' }, t('fishAuditError')),
                      )),
                      h('tbody', null, audit.map((entry, position) => h('tr', { key: `${entry?.at ?? ''}:${position}` },
                        h('td', { className: 'ow-cell-time' }, formatTime(entry?.at)),
                        h('td', null, auditActionLabel(t, entry?.action)),
                        h('td', null, entry?.checkpointId ? h('code', { className: 'ow-code' }, entry.checkpointId) : '—'),
                        h('td', null, h(Badge, {
                          tone: entry?.result === 'ok' ? 'ok' : entry?.result === 'failed' ? 'error' : 'idle',
                        }, auditResultLabel(t, entry?.result))),
                        h('td', { className: 'ow-cell-summary' }, entry?.error ? h('span', { className: 'ow-tone-error' }, entry.error) : '—'),
                      ))),
                    ),
                  ),
            ),
      )
    }

    function sourceIdFilter(errors, sourceId) {
      if (sourceId === null || sourceId === undefined) return errors
      return errors.filter((error) => error?.sourceId === undefined || error?.sourceId === null || error?.sourceId === sourceId)
    }

    function RestoreDialog({ dialogRef, restore, onConfirm, onOverrideChange, onClose, onRetryPreflight, onRetryIntent, onRetryResult, t }) {
      if (restore === null) return null
      const stage = restore.stage
      const files = asArray(restore.files)
      const restorable = asArray(restore.restorable)
      const staleFiles = asArray(restore.staleFiles)
      const warnings = asArray(restore.warnings)
      const executing = stage === 'executing'
      const currentStep = stage === 'result'
        ? 2
        : stage === 'error'
          ? (restore.preflightError !== null && restore.preflightError !== undefined ? 0 : 1)
          : stage === 'confirm' || stage === 'executing' ? 1 : 0
      const steps = [t('fishRestoreStepPreflight'), t('fishRestoreStepConfirm'), t('fishRestoreStepResult')]
      const sourceName = restore.sourceName ?? restore.sourceId ?? '—'
      const resultFiles = asArray(restore.result?.files)
      const skipped = files.filter((file) => file?.action !== 'restore').length
      const canExecute = restore.intentStatus === 'recorded'
        && restorable.length > 0
        && (staleFiles.length === 0 || restore.overrideStale === true)
      return h('aside', {
        className: 'ow-dialog',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': 'ow-restore-title',
        tabIndex: -1,
        ref: dialogRef,
      },
        h('div', { className: 'ow-dialog-head' },
          h('div', null,
            h('h2', { id: 'ow-restore-title', className: 'ow-drawer-title' }, t('fishRestoreTitle')),
            h('p', { className: 'ow-drawer-sub' },
              h('code', { className: 'ow-code' }, restore.checkpointId ?? '—'),
              ' · ',
              sourceName,
            ),
          ),
          h('button', {
            type: 'button',
            className: 'ow-btn ow-btn-small',
            disabled: executing,
            onClick: onClose,
            'aria-label': t('close'),
          }, t('close')),
        ),
        h('ol', { className: 'ow-steps', 'aria-label': t('fishRestoreTitle') },
          steps.map((label, index) => h('li', {
            key: label,
            className: `ow-step ${index < currentStep ? 'ow-step-done' : ''} ${index === currentStep ? 'ow-step-current' : ''}`,
            'aria-current': index === currentStep ? 'step' : undefined,
          },
            h('span', { className: 'ow-step-index', 'aria-hidden': true }, String(index + 1)),
            h('span', null, label),
          )),
        ),
        stage === 'preflight'
          ? h('p', { className: 'ow-state-inline', role: 'status' }, t('fishRestorePreflight'))
          : null,
        stage === 'error'
          ? h('div', { className: 'ow-dialog-body' },
              h(ErrorNotice, {
                error: restore.preflightError ?? restore.executeError ?? restore.intentError,
                title: restore.preflightError !== null && restore.preflightError !== undefined ? t('fishRestorePreflightFailed') : t('fishRestoreError'),
                onRetry: onRetryPreflight,
                t,
              }),
              h('p', { className: 'ow-muted ow-small' }, t('fishRestoreSafetyGit')),
              restore.resultRecord === 'recording'
                ? h('p', { role: 'status', className: 'ow-muted ow-small' }, t('fishRestoreResultRecording'))
                : restore.resultRecord === 'recorded'
                  ? h('p', { role: 'status', className: 'ow-tone-ok ow-small' }, t('fishRestoreRecorded'))
                  : restore.resultRecord === 'error'
                    ? h('div', { className: 'ow-restore-intent-error' },
                        h('p', { role: 'alert', className: 'ow-tone-warn' }, t('fishRestoreResultRecordFailed')),
                        h(ErrorNotice, { error: restore.resultRecordError, title: t('fishRestoreResultRecordFailed'), onRetry: onRetryResult, t }),
                      )
                    : null,
            )
          : null,
        stage === 'confirm' || stage === 'executing' || stage === 'result'
          ? h('div', { className: 'ow-dialog-body' },
              h('section', { className: 'ow-drawer-section' },
                h('h3', null, t('fishRestorePlan')),
                h('p', { className: 'ow-muted ow-small' }, t('fishRestorePlanHint')),
                h('p', null, t('fishRestorePlanCount', {
                  count: formatNumber(restorable.length),
                  skipped: formatNumber(skipped),
                })),
                warnings.length > 0
                  ? h('div', { className: 'ow-restore-warnings', role: 'alert' },
                      h('strong', null, t('fishRestoreWarnings')),
                      h('ul', null, warnings.map((warning, index) => h('li', { key: `${index}:${String(warning)}` }, String(warning)))),
                    )
                  : h('p', { className: 'ow-muted ow-small' }, t('fishRestoreNoWarnings')),
                staleFiles.length > 0
                  ? h('div', { className: 'ow-restore-stale', role: 'alert' },
                      h('strong', { className: 'ow-tone-warn' }, t('fishRestoreStale')),
                      h('p', null, t('fishRestoreStaleHint')),
                      h('ul', null, staleFiles.map((path) => h('li', { key: String(path) }, h('code', { className: 'ow-code' }, String(path))))),
                      stage === 'confirm'
                        ? h('label', { className: 'ow-check' },
                            h('input', {
                              type: 'checkbox',
                              checked: restore.overrideStale === true,
                              onChange: (event) => onOverrideChange(event.target.checked),
                            }),
                            t('fishRestoreOverride'),
                          )
                        : null,
                    )
                  : null,
                files.length > 0
                  ? h('div', { className: 'ow-table-wrap' },
                      h('table', { className: 'ow-table ow-restore-files' },
                        h('caption', { className: 'ow-sr' }, t('fishRestorePlan')),
                        h('thead', null, h('tr', null,
                          h('th', { scope: 'col' }, t('fishRestoreFile')),
                          h('th', { scope: 'col' }, t('fishRestoreActionCol')),
                          h('th', { scope: 'col' }, t('fishRestoreStaleCol')),
                          h('th', { scope: 'col' }, t('fishRestoreBytes')),
                        )),
                        h('tbody', null, files.map((file, index) => h('tr', { key: `${file?.path ?? 'file'}:${index}` },
                          h('td', null, h('code', { className: 'ow-code' }, file?.path ?? '—')),
                          h('td', null, file?.action === 'restore' ? t('fishRestoreFileRestore') : t('fishRestoreFileSkip')),
                          h('td', null, file?.stale === true ? h('span', { className: 'ow-tone-warn' }, t('yes')) : t('no')),
                          h('td', null, formatBytes(file?.bytes)),
                        ))),
                      ),
                    )
                  : null,
                restorable.length === 0
                  ? h('p', { className: 'ow-tone-error' }, t('fishRestoreNothing'))
                  : null,
              ),
              h('section', { className: 'ow-safety' },
                h('h3', null, t('fishRestoreSafetyTitle')),
                h('ul', { className: 'ow-safety-list' },
                  h('li', null, t('fishRestoreSafety')),
                  h('li', null, t('fishRestoreSafetyCheckpoint')),
                  h('li', null, t('fishRestoreSafetyGit')),
                ),
              ),
              stage === 'confirm'
                ? h('section', { className: 'ow-drawer-section' },
                    h('p', null, t('fishRestoreConfirm', { id: restore.checkpointId ?? '—', source: sourceName })),
                    restore.intentStatus === 'recording'
                      ? h('p', { role: 'status', className: 'ow-muted ow-small' }, t('fishRestoreIntentRecording'))
                      : restore.intentStatus === 'recorded'
                        ? h('p', { role: 'status', className: 'ow-tone-ok ow-small' }, t('fishRestoreIntentRecorded'))
                        : restore.intentStatus === 'error'
                          ? h('div', { className: 'ow-restore-intent-error' },
                              h('p', { role: 'alert', className: 'ow-tone-error' }, t('fishRestoreIntentFailed')),
                              h(ErrorNotice, { error: restore.intentError, title: t('fishRestoreIntentFailed'), onRetry: onRetryIntent, t }),
                            )
                          : null,
                    restore.executeError !== null && restore.executeError !== undefined
                      ? h(ErrorNotice, { error: restore.executeError, title: t('fishRestoreError'), onRetry: onRetryPreflight, t })
                      : null,
                    h('div', { className: 'ow-dialog-actions' },
                      h('span', { className: 'ow-hint' }, t('fishRestoreCloseHint')),
                      h('button', { type: 'button', className: 'ow-btn ow-btn-small', onClick: onClose }, t('cancel')),
                      h('button', {
                        type: 'button',
                        className: 'ow-btn ow-btn-primary',
                        disabled: !canExecute,
                        'aria-disabled': !canExecute,
                        onClick: onConfirm,
                      }, t('fishRestoreExecute')),
                    ),
                  )
                : null,
              stage === 'executing'
                ? h('p', { className: 'ow-state-inline', role: 'status' }, t('fishRestoreExecuting'))
                : null,
              stage === 'result'
                ? h('section', { className: 'ow-drawer-section ow-restore-result' },
                    h('div', { className: 'ow-card-head' },
                      h('h3', null, t('fishRestoreResultTitle')),
                      h(Badge, { tone: restore.result?.ok === true ? 'ok' : 'error' },
                        restore.result?.ok === true ? t('fishRestoreOk') : t('fishRestorePartial')),
                    ),
                    h('p', null, t('fishRestoreRestored', {
                      count: formatNumber(typeof restore.result?.restored === 'number' ? restore.result.restored : resultFiles.filter((file) => file?.ok === true).length),
                    })),
                    restore.result?.safetyCheckpointId
                      ? h('p', null,
                          `${t('fishRestoreSafetyCheckpointId')}: `,
                          h('code', { className: 'ow-code' }, String(restore.result.safetyCheckpointId)),
                        )
                      : null,
                    h('h3', null, t('fishRestorePerFile')),
                    resultFiles.length === 0
                      ? h('p', { className: 'ow-muted' }, t('fishRestoreNothing'))
                      : h('div', { className: 'ow-table-wrap' },
                          h('table', { className: 'ow-table ow-restore-results' },
                            h('caption', { className: 'ow-sr' }, t('fishRestorePerFile')),
                            h('thead', null, h('tr', null,
                              h('th', { scope: 'col' }, t('fishRestoreFile')),
                              h('th', { scope: 'col' }, t('doctorStatusCol')),
                            )),
                            h('tbody', null, resultFiles.map((file, index) => h('tr', { key: `${file?.path ?? 'file'}:${index}` },
                              h('td', null, h('code', { className: 'ow-code' }, file?.path ?? '—')),
                              h('td', null, h(Badge, { tone: file?.ok === true ? 'ok' : 'error' },
                                file?.ok === true ? t('fishRestoreFileOk') : t('fishRestoreFileFailed'))),
                            ))),
                          ),
                        ),
                    restore.resultRecord === 'recording'
                      ? h('p', { role: 'status', className: 'ow-muted ow-small' }, t('fishRestoreResultRecording'))
                      : restore.resultRecord === 'recorded'
                        ? h('p', { role: 'status', className: 'ow-tone-ok ow-small' }, t('fishRestoreRecorded'))
                        : restore.resultRecord === 'error'
                          ? h('div', { className: 'ow-restore-intent-error' },
                              h('p', { role: 'alert', className: 'ow-tone-warn' }, t('fishRestoreResultRecordFailed')),
                              h(ErrorNotice, { error: restore.resultRecordError, title: t('fishRestoreResultRecordFailed'), onRetry: onRetryResult, t }),
                            )
                          : null,
                    h('div', { className: 'ow-dialog-actions' },
                      h('span', { className: 'ow-hint' }, t('fishRestoreCloseHint')),
                      h('button', { type: 'button', className: 'ow-btn ow-btn-primary', onClick: onClose }, t('close')),
                    ),
                  )
                : null,
            )
          : null,
      )
    }

    function ReplayView({ runId, events, total, hasMore, ready, error, loadingMore, onLoadMore, onRetry, t }) {
      const list = asArray(events)
      const counts = { swarm: 0, pressure: 0, watch: 0 }
      for (const event of list) {
        if (event?.source === 'swarm' || event?.source === 'pressure' || event?.source === 'watch') {
          counts[event.source] += 1
        }
      }
      return h('div', { className: 'ow-replay' },
        h('section', { className: 'ow-card' },
          h('div', { className: 'ow-card-head' },
            h('div', null,
              h('h2', null, t('replayTitle')),
              h('p', { className: 'ow-muted ow-small ow-subtitle' }, t('replaySubtitle')),
              h('p', { className: 'ow-muted ow-small' },
                `${t('runIdLabel')}: `,
                h('code', { className: 'ow-code' }, runId ?? '—'),
              ),
            ),
            h('span', { className: 'ow-muted ow-small' }, t('replayCount', {
              loaded: formatNumber(list.length),
              total: typeof total === 'number' && Number.isFinite(total) ? formatNumber(total) : '—',
            })),
          ),
          h('div', { className: 'ow-legend', role: 'list', 'aria-label': t('replayLegend') },
            ['swarm', 'pressure', 'watch'].map((source) => h('span', {
              key: source,
              className: 'ow-legend-item',
              role: 'listitem',
            },
              sourceChip(t, source),
              h('span', { className: 'ow-muted ow-small' }, formatNumber(counts[source])),
            )),
          ),
          h('p', { className: 'ow-hint' }, t('replayAutoHint')),
          h('p', { className: 'ow-hint ow-muted' }, t('replayCursorHint')),
        ),
        h(ErrorNotice, { error, title: t('replayError'), onRetry, t }),
        !ready && (error === null || error === undefined)
          ? h('section', { className: 'ow-card ow-state', role: 'status' }, t('loading'))
          : null,
        ready && list.length === 0 && (error === null || error === undefined)
          ? h('section', { className: 'ow-card ow-state' }, t('replayEmpty'))
          : null,
        list.length > 0
          ? h('section', { className: 'ow-card ow-replay-events' },
              h('div', { className: 'ow-table-wrap' },
                h('table', { className: 'ow-table ow-replay-table' },
                  h('caption', { className: 'ow-sr' }, t('replayEvents')),
                  h('thead', null, h('tr', null,
                    h('th', { scope: 'col' }, t('eventTime')),
                    h('th', { scope: 'col' }, t('replaySourceCol')),
                    h('th', { scope: 'col' }, t('eventType')),
                    h('th', { scope: 'col' }, t('eventActor')),
                    h('th', { scope: 'col' }, t('eventSummary')),
                  )),
                  h('tbody', null, list.map((event, index) => h('tr', { key: eventKey(event) ?? String(index) },
                    h('td', {
                      className: 'ow-cell-time',
                      title: hasTime(event?.at) ? formatTime(event.at) : t('unknownTime'),
                    }, hasTime(event?.at) ? formatTime(event.at) : h('span', { className: 'ow-muted' }, t('unknownTime'))),
                    h('td', null, sourceChip(t, event?.source)),
                    h('td', null, h('code', { className: 'ow-code' }, event?.type ?? '—')),
                    h('td', null, event?.actor ?? '—'),
                    h('td', { className: 'ow-cell-summary' }, event?.summary ?? '—'),
                  ))),
                ),
              ),
              h('div', { className: 'ow-replay-foot' },
                hasMore
                  ? h('button', {
                      type: 'button',
                      className: 'ow-btn ow-btn-small',
                      disabled: loadingMore,
                      onClick: onLoadMore,
                    }, loadingMore ? t('replayLoadingMore') : t('replayLoadMore'))
                  : h('span', { className: 'ow-muted ow-small' }, t('replayAllLoaded')),
              ),
            )
          : null,
      )
    }

    function EmptyState({ t }) {
      return h('section', { className: 'ow-card ow-empty' },
        h('h2', null, t('emptyTitle')),
        h('p', null, t('emptyBody')),
        h('div', { className: 'ow-empty-grid' },
          h('div', { className: 'ow-empty-option' },
            h('h3', null, t('emptyTool')),
            h('p', null, t('emptyToolBody')),
            h('pre', { className: 'ow-code-block' }, h('code', null, 'watch_arm')),
          ),
          h('div', { className: 'ow-empty-option' },
            h('h3', null, t('emptyHttp')),
            h('p', null, t('emptyHttpBody')),
            h('pre', { className: 'ow-code-block' }, h('code', null,
              'POST /overwatch/api/runs/:id/arm\n'
              + 'x-overwatch-token: <token>\n'
              + 'content-type: application/json\n\n'
              + '{"mode":"guard"}',
            )),
          ),
        ),
        h('p', { className: 'ow-muted ow-small' }, t('emptyNote')),
      )
    }

    function CasesPanel({
      cases,
      filter,
      error,
      ready,
      asOf,
      onFilter,
      onOpenCase,
      onRetry,
      t,
    }) {
      const list = asArray(cases)
      return h('div', { className: 'ow-cases' },
        h('section', { className: 'ow-card' },
          h('div', { className: 'ow-card-head' },
            h('div', null,
              h('h2', null, t('casesTitle')),
              h('p', { className: 'ow-muted ow-small ow-subtitle' }, t('casesSubtitle')),
            ),
            h('div', { className: 'ow-filter', role: 'group', 'aria-label': t('casesTitle') },
              h('button', {
                type: 'button',
                className: 'ow-btn ow-btn-small',
                'aria-pressed': filter === 'open',
                onClick: () => onFilter('open'),
              }, t('filterOpen')),
              h('button', {
                type: 'button',
                className: 'ow-btn ow-btn-small',
                'aria-pressed': filter === 'all',
                onClick: () => onFilter('all'),
              }, t('filterAll')),
            ),
          ),
          h('div', { className: 'ow-inline-meta' },
            h('span', { className: 'ow-muted ow-small' }, t('selectCaseHint')),
            asOf ? h('span', { className: 'ow-muted ow-small' }, t('asOf', { time: formatTime(asOf) })) : null,
          ),
        ),
        h(ErrorNotice, { error, title: t('caseTable'), onRetry, t }),
        h('section', { className: 'ow-card ow-case-table' },
          !ready && error === null
            ? h('p', { className: 'ow-muted' }, t('loading'))
            : list.length === 0
              ? h('p', { className: 'ow-muted' }, error !== null ? t('caseListUnavailable') : (filter === 'open' ? t('noOpenCases') : t('noCases')))
              : h('div', { className: 'ow-table-wrap' },
                  h('table', { className: 'ow-table' },
                    h('caption', { className: 'ow-sr' }, t('caseTable')),
                    h('thead', null, h('tr', null,
                      h('th', { scope: 'col' }, t('colSeverity')),
                      h('th', { scope: 'col' }, t('colTime')),
                      h('th', { scope: 'col' }, t('colCode')),
                      h('th', { scope: 'col' }, t('colTitle')),
                      h('th', { scope: 'col' }, t('colState')),
                    )),
                    h('tbody', null, list.map((entry) => h('tr', {
                      key: String(entry.id),
                      onClick: () => onOpenCase(entry),
                    },
                      h('td', null, severityCell(t, entry.severity)),
                      h('td', { className: 'ow-cell-time', title: formatTime(entry.openedAt) }, formatTime(entry.openedAt)),
                      h('td', null, h('code', { className: 'ow-code' }, entry.code ?? '—')),
                      h('td', { className: 'ow-cell-title' },
                        h('button', {
                          type: 'button',
                          className: 'ow-row-open',
                          'aria-haspopup': 'dialog',
                          'aria-label': t('openCaseA11y', {
                            severity: severityText(t, entry.severity),
                            code: entry.code ?? '—',
                            title: entry.title ?? t('untitled'),
                            state: translateCode(t, 'caseState', entry.state),
                          }),
                          onClick: (event) => {
                            event.stopPropagation()
                            onOpenCase(entry)
                          },
                        }, entry.title ?? t('untitled')),
                      ),
                      h('td', null, translateCode(t, 'caseState', entry.state)),
                    ))),
                  ),
                  list.length >= 100 ? h('p', { className: 'ow-muted ow-small ow-limit' }, t('casesLimitNote')) : null,
                ),
        ),
      )
    }

    function severityCell(t, severity) {
      const code = typeof severity === 'string' ? severity.toUpperCase() : ''
      const tone = code === 'L4' || code === 'L3' ? 'error' : code === 'L2' ? 'warn' : 'brand'
      return h(Badge, { tone, title: severityText(t, severity) }, severityText(t, severity))
    }

    function CaseDrawer({
      drawerRef,
      summary,
      detail,
      detailError,
      loading,
      tokenSet,
      writeOpen,
      writeBusy,
      ackNote,
      ackConfirm,
      ackError,
      ackNotice,
      onAckNote,
      onAckStart,
      onAckCancel,
      onAck,
      closeReason,
      closeConfirm,
      onCloseReason,
      onCloseStart,
      onCloseCancel,
      onCloseCase,
      onClose,
      t,
    }) {
      const data = detail?.case ?? summary
      const title = data?.title ?? t('untitled')
      const state = data?.state ?? 'open'
      const isOpen = String(state) === 'open'
      const signals = asArray(data?.signals)
      const evidence = asArray(data?.evidence)
      const actions = asArray(data?.actions)
      const decisions = asArray(data?.decisions)
      const canWrite = writeOpen && tokenSet
      return h('aside', {
        className: 'ow-drawer',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': 'ow-drawer-title',
        tabIndex: -1,
        ref: drawerRef,
        onClick: (event) => event.stopPropagation(),
      },
        h('div', { className: 'ow-drawer-head' },
          h('div', null,
            h('h2', { id: 'ow-drawer-title', className: 'ow-drawer-title' }, title),
            h('p', { className: 'ow-drawer-sub' },
              h('code', { className: 'ow-code' }, data?.code ?? '—'),
              ' · ',
              severityText(t, data?.severity),
              ' · ',
              translateCode(t, 'caseState', state),
            ),
          ),
          h('button', { type: 'button', className: 'ow-btn ow-btn-small', onClick: onClose, 'aria-label': t('close') }, t('close')),
        ),
        h(ErrorNotice, { error: detailError, title: t('caseDetail'), t }),
        !detail && loading ? h('p', { className: 'ow-muted' }, t('loading')) : null,
        h('section', { className: 'ow-drawer-section' },
          h('h3', null, t('caseMeta')),
          h('dl', { className: 'ow-dl' },
            dtDd(t('openedAt'), formatTime(data?.openedAt)),
            dtDd(t('updatedAt'), formatTime(data?.updatedAt)),
            dtDd(t('closedAt'), formatTime(data?.closedAt)),
            dtDd(t('closeReason'), closeReasonText(t, data?.closeReason)),
          ),
        ),
        h('section', { className: 'ow-drawer-section' },
          h('h3', null, t('signals')),
          signals.length === 0
            ? h('p', { className: 'ow-muted' }, t('noSignals'))
            : h('ul', { className: 'ow-signal-list' },
                signals.map((signal, index) => h('li', { key: `${signal.code ?? 'signal'}:${index}`, className: 'ow-signal' },
                  h('code', { className: 'ow-code' }, signal.code ?? '—'),
                  h('span', null, `${t('signalValue')}: ${formatScalar(signal.value, t)}`),
                  h('span', null, `${t('signalThreshold')}: ${formatScalar(signal.threshold, t)}`),
                  signal.severity ? h(Badge, { tone: signal.severity === 'L4' || signal.severity === 'L3' ? 'error' : 'warn' }, signal.severity) : null,
                )),
              ),
        ),
        h('section', { className: 'ow-drawer-section' },
          h('h3', null, t('evidence')),
          evidence.length === 0
            ? h('p', { className: 'ow-muted' }, t('noEvidence'))
            : h('ul', { className: 'ow-evidence-list' },
                evidence.map((item, index) => h('li', { key: `${item.kind ?? 'ref'}:${item.id ?? index}`, className: 'ow-evidence' },
                  h('code', { className: 'ow-code' }, item.kind ?? '—'),
                  h('code', { className: 'ow-code' }, item.id ?? '—'),
                  h('span', null, item.source ?? '—'),
                  h('span', { className: 'ow-muted ow-small' }, formatTime(item.at)),
                )),
              ),
        ),
        h('section', { className: 'ow-drawer-section' },
          h('h3', null, t('actions')),
          actions.length === 0
            ? h('p', { className: 'ow-muted' }, t('noActions'))
            : h('ol', { className: 'ow-action-list' },
                actions.map((action, index) => h('li', {
                  key: `${action.id ?? 'action'}:${index}`,
                  className: 'ow-action',
                  'data-state': String(action.state ?? ''),
                },
                  h('span', { className: 'ow-action-dot', 'aria-hidden': true }),
                  h('div', { className: 'ow-action-body' },
                    h('div', { className: 'ow-action-head' },
                      h('code', { className: 'ow-code' }, translateCode(t, 'actionKind', action.kind)),
                      h('span', null, translateCode(t, 'actionState', action.state)),
                    ),
                    h('span', { className: 'ow-action-time' }, formatTime(action.at)),
                  ),
                )),
              ),
        ),
        h('section', { className: 'ow-drawer-section' },
          h('h3', null, t('decisions')),
          decisions.length === 0
            ? h('p', { className: 'ow-muted' }, t('noDecisions'))
            : h('ul', { className: 'ow-decision-list' },
                decisions.map((decision, index) => h('li', { key: `decision:${index}`, className: 'ow-evidence' },
                  h('span', null, formatScalar(decision, t)),
                )),
              ),
        ),
        h('section', { className: 'ow-ack' },
          h('h3', null, t('ack')),
          !isOpen
            ? h('p', { className: 'ow-muted ow-small' }, String(state) === 'closed' ? t('ackClosed') : t('ackNotOpen'))
            : canWrite
              ? h('div', { className: 'ow-ack-form' },
                  h('label', { className: 'ow-field' },
                    h('span', null, t('ackNote')),
                    h('textarea', {
                      className: 'ow-textarea',
                      rows: 2,
                      maxLength: 300,
                      value: ackNote,
                      placeholder: t('ackNotePlaceholder'),
                      onChange: (event) => onAckNote(event.target.value),
                    }),
                  ),
                  ackConfirm
                    ? h('div', { className: 'ow-confirm' },
                        h('span', null, t('ackConfirm')),
                        h('button', { type: 'button', className: 'ow-btn ow-btn-primary ow-btn-small', disabled: writeBusy !== null, onClick: onAck }, writeBusy !== null ? t('ackPending') : t('confirm')),
                        h('button', { type: 'button', className: 'ow-btn ow-btn-small', disabled: writeBusy !== null, onClick: onAckCancel }, t('cancel')),
                      )
                    : h('button', {
                        type: 'button',
                        className: 'ow-btn ow-btn-primary ow-btn-small',
                        disabled: writeBusy !== null,
                        onClick: onAckStart,
                      }, t('ack')),
                )
              : h('p', { className: 'ow-muted ow-small' }, t('ackLocked')),
          ackNotice ? h('p', { className: 'ow-notice', role: 'status' }, ackNotice) : null,
          ackError ? h(ErrorNotice, { error: ackError, title: t('writeError'), t }) : null,
        ),
        h('section', { className: 'ow-ack' },
          h('h3', null, t('closeCase')),
          !isOpen
            ? h('p', { className: 'ow-muted ow-small' }, t('ackClosed'))
            : canWrite
              ? h('div', { className: 'ow-ack-form' },
                  h('label', { className: 'ow-field' },
                    h('span', null, t('closeReason')),
                    h('select', {
                      className: 'ow-select',
                      value: closeReason,
                      onChange: (event) => onCloseReason(event.target.value),
                    },
                      h('option', { value: 'resolved' }, t('closeReasonResolved')),
                      h('option', { value: 'mitigated' }, t('closeReasonMitigated')),
                      h('option', { value: 'escalated' }, t('closeReasonEscalated')),
                      h('option', { value: 'false_positive' }, t('closeReasonFalsePositive')),
                    ),
                  ),
                  closeConfirm
                    ? h('div', { className: 'ow-confirm' },
                        h('span', null, t('closeConfirm')),
                        h('button', { type: 'button', className: 'ow-btn ow-btn-primary ow-btn-small', disabled: writeBusy !== null, onClick: onCloseCase }, writeBusy !== null ? t('closePending') : t('confirm')),
                        h('button', { type: 'button', className: 'ow-btn ow-btn-small', disabled: writeBusy !== null, onClick: onCloseCancel }, t('cancel')),
                      )
                    : h('button', {
                        type: 'button',
                        className: 'ow-btn ow-btn-danger ow-btn-small',
                        disabled: writeBusy !== null,
                        onClick: onCloseStart,
                      }, t('closeCase')),
                )
              : h('p', { className: 'ow-muted ow-small' }, t('ackLocked')),
        ),
      )
    }

    function WritePanel({
      tokenSet,
      tokenDraft,
      tokenMemoryOnly,
      tokenNotice,
      tokenError,
      onTokenDraft,
      onSaveToken,
      onClearToken,
      onHide,
      selectedRun,
      runArmed,
      armMode,
      onArmMode,
      disarmReason,
      onDisarmReason,
      confirmAction,
      onRequestArm,
      onRequestDisarm,
      onRequestResume,
      onRequestPurge,
      onConfirm,
      onCancelConfirm,
      writeBusy,
      writeNotice,
      writeError,
      runStatus,
      runThrottle,
      approvals = [],
      onApproveApproval,
      onRejectApproval,
      t,
    }) {
      const busy = writeBusy !== null
      return h('section', { id: 'ow-write-panel', className: 'ow-card ow-write', 'aria-label': t('writeOps') },
        h('div', { className: 'ow-card-head' },
          h('div', null,
            h('h2', null, t('writeOps')),
            h('p', { className: 'ow-muted ow-small ow-subtitle' }, t('writeGuardOnly')),
          ),
          h('div', { className: 'ow-actions-row' },
            h(Badge, { tone: tokenSet ? 'ok' : 'idle' }, tokenSet ? t('writeUnlocked') : t('readOnlyBadge')),
            h('button', { type: 'button', className: 'ow-btn ow-btn-small', onClick: onHide }, t('writeOpsHide')),
          ),
        ),
        h('form', {
          className: 'ow-token-form',
          onSubmit: (event) => {
            event.preventDefault()
            onSaveToken()
          },
        },
          h('label', { className: 'ow-field' },
            h('span', null, t('tokenLabel')),
            h('input', {
              type: 'password',
              className: 'ow-input',
              value: tokenDraft,
              placeholder: t('tokenPlaceholder'),
              autoComplete: 'off',
              spellCheck: false,
              onChange: (event) => onTokenDraft(event.target.value),
            }),
          ),
          h('div', { className: 'ow-token-actions' },
            h('button', {
              type: 'submit',
              className: 'ow-btn ow-btn-primary ow-btn-small',
              disabled: tokenDraft.length === 0,
            }, t('tokenSave')),
            tokenSet ? h('button', { type: 'button', className: 'ow-btn ow-btn-small', onClick: onClearToken }, t('tokenClear')) : null,
          ),
        ),
        h('p', { className: 'ow-hint' }, t('tokenSessionHint')),
        h('p', { className: 'ow-hint' }, tokenSet ? t('tokenSet') : t('tokenNotSet')),
        tokenMemoryOnly ? h('p', { className: 'ow-hint ow-tone-warn' }, t('tokenMemoryOnly')) : null,
        tokenNotice ? h('p', { className: 'ow-notice', role: 'status' }, tokenNotice) : null,
        tokenError ? h(ErrorNotice, { error: tokenError, title: t('writeError'), t }) : null,
        h('p', { className: 'ow-hint' }, t('writeDisabledHint')),
        h('div', { className: 'ow-write-ops' },
          h('h3', null, t('writeOps')),
          selectedRun === null
            ? h('p', { className: 'ow-muted ow-small' }, t('writeRunRequired'))
            : !tokenSet
              ? h('p', { className: 'ow-muted ow-small' }, t('tokenRequired'))
              : h('div', { className: 'ow-write-controls' },
                  runArmed
                    ? h('div', { className: 'ow-write-group' },
                        h('label', { className: 'ow-field' },
                          h('span', null, t('disarmReason')),
                          h('input', {
                            type: 'text',
                            className: 'ow-input',
                            value: disarmReason,
                            placeholder: t('disarmReasonPlaceholder'),
                            maxLength: 500,
                            onChange: (event) => onDisarmReason(event.target.value),
                          }),
                        ),
                        h('button', {
                          type: 'button',
                          className: 'ow-btn ow-btn-danger ow-btn-small',
                          disabled: busy,
                          onClick: onRequestDisarm,
                        }, busy ? t('writePending') : t('disarm')),
                      )
                    : h('div', { className: 'ow-write-group' },
                        h('label', { className: 'ow-field' },
                          h('span', null, t('armMode')),
                          h('select', {
                            className: 'ow-select',
                            value: armMode,
                            onChange: (event) => onArmMode(event.target.value),
                          },
                            h('option', { value: 'guard' }, t('armGuard')),
                            h('option', { value: 'observe' }, t('armObserve')),
                            h('option', { value: 'supervised' }, t('armSupervised')),
                          ),
                        ),
                        h('button', {
                          type: 'button',
                          className: 'ow-btn ow-btn-primary ow-btn-small',
                          disabled: busy,
                          onClick: onRequestArm,
                        }, busy ? t('writePending') : t('arm')),
                      ),
                ),
          h('div', { className: 'ow-write-group' },
            h('div', { className: 'ow-actions-row' },
              runArmed && (String(runStatus) === 'paused' || runThrottle !== null)
                ? h('button', {
                    type: 'button',
                    className: 'ow-btn ow-btn-primary ow-btn-small',
                    disabled: busy,
                    onClick: onRequestResume,
                  }, t('resumeRun'))
                : null,
              !runArmed
                ? h('button', {
                    type: 'button',
                    className: 'ow-btn ow-btn-danger ow-btn-small',
                    disabled: busy,
                    onClick: onRequestPurge,
                  }, t('purgeRun'))
                : null,
            ),
          ),
          confirmAction !== null
            ? h('div', { className: 'ow-confirm', role: 'group', 'aria-label': t('confirm') },
                h('span', null, confirmAction.kind === 'arm'
                  ? t('armConfirm', { mode: armModeLabel(t, confirmAction.mode) })
                  : confirmAction.kind === 'disarm'
                    ? t('disarmConfirm')
                    : confirmAction.kind === 'resume'
                      ? t('resumeConfirm')
                      : t('purgeConfirm', { runId: selectedRun?.runId ?? '' })),
                h('button', { type: 'button', className: 'ow-btn ow-btn-primary ow-btn-small', disabled: busy, onClick: onConfirm }, t('confirm')),
                h('button', { type: 'button', className: 'ow-btn ow-btn-small', disabled: busy, onClick: onCancelConfirm }, t('cancel')),
              )
            : null,
          h('div', { className: 'ow-write-ops' },
            h('h3', null, t('approvals')),
            !tokenSet
              ? h('p', { className: 'ow-muted ow-small' }, t('approvalLocked'))
              : approvals.length === 0
                ? h('p', { className: 'ow-muted ow-small' }, t('noApprovals'))
                : h('ul', { className: 'ow-signal-list' },
                    approvals.map((approval) => h('li', { key: approval.id, className: 'ow-signal' },
                      h('div', { className: 'ow-actions-row' },
                        h(Badge, { tone: 'warn' }, approval.action),
                        h('code', { className: 'ow-code' }, approval.caseId ?? '—'),
                      ),
                      h('span', null, `${t('approvalReason')}: ${approval.reason ?? '—'}`),
                      h('span', { className: 'ow-muted ow-small' }, t('approvalExpires', { time: formatTime(approval.expiresAt) })),
                      h('div', { className: 'ow-actions-row' },
                        h('button', {
                          type: 'button',
                          className: 'ow-btn ow-btn-primary ow-btn-small',
                          disabled: busy,
                          'aria-label': `${t('approvalApprove')} ${approval.action} ${approval.caseId ?? ''}`.trim(),
                          onClick: () => onApproveApproval(approval.id),
                        }, busy ? t('approvalPending') : t('approvalApprove')),
                        h('button', {
                          type: 'button',
                          className: 'ow-btn ow-btn-small',
                          disabled: busy,
                          'aria-label': `${t('approvalReject')} ${approval.action} ${approval.caseId ?? ''}`.trim(),
                          onClick: () => onRejectApproval(approval.id),
                        }, t('approvalReject')),
                      ),
                    )),
                  ),
          ),
          writeNotice ? h('p', { className: 'ow-notice', role: 'status' }, writeNotice) : null,
          writeError ? h(ErrorNotice, { error: writeError, title: t('writeError'), t }) : null,
        ),
      )
    }

    function OverwatchPage() {
      const t = useLocale()
      const [tab, setTab] = useState('room')
      const [health, setHealth] = useState(null)
      const [healthError, setHealthError] = useState(null)
      const [runs, setRuns] = useState([])
      const [runsAsOf, setRunsAsOf] = useState(null)
      const [lastRunsAt, setLastRunsAt] = useState(null)
      const [runsReady, setRunsReady] = useState(false)
      const [runsError, setRunsError] = useState(null)
      const [selectedRunId, setSelectedRunId] = useState(null)
      const [runDetail, setRunDetail] = useState(null)
      const [runError, setRunError] = useState(null)
      const [timeline, setTimeline] = useState([])
      const [timelineError, setTimelineError] = useState(null)
      const [caseFilter, setCaseFilter] = useState('open')
      const [cases, setCases] = useState([])
      const [casesAsOf, setCasesAsOf] = useState(null)
      const [casesReady, setCasesReady] = useState(false)
      const [casesError, setCasesError] = useState(null)
      const [selectedCase, setSelectedCase] = useState(null)
      const [caseDetail, setCaseDetail] = useState(null)
      const [caseDetailError, setCaseDetailError] = useState(null)
      const [caseDetailLoading, setCaseDetailLoading] = useState(false)
      const [writeOpen, setWriteOpen] = useState(false)
      const [token, setToken] = useState(readWriteToken)
      const [tokenDraft, setTokenDraft] = useState('')
      const [tokenMemoryOnly, setTokenMemoryOnly] = useState(false)
      const [tokenNotice, setTokenNotice] = useState(null)
      const [tokenError, setTokenError] = useState(null)
      const [writeBusy, setWriteBusy] = useState(null)
      const [writeError, setWriteError] = useState(null)
      const [writeNotice, setWriteNotice] = useState(null)
      const [confirmAction, setConfirmAction] = useState(null)
      const [armMode, setArmMode] = useState('guard')
      const [disarmReason, setDisarmReason] = useState('')
      const [ackNote, setAckNote] = useState('')
      const [ackConfirm, setAckConfirm] = useState(false)
      const [ackError, setAckError] = useState(null)
      const [ackNotice, setAckNotice] = useState(null)
      const [closeReason, setCloseReason] = useState('resolved')
      const [closeConfirm, setCloseConfirm] = useState(false)
      const [approvals, setApprovals] = useState([])
      const [approvalsRefresh, setApprovalsRefresh] = useState(0)
      const [refreshKey, setRefreshKey] = useState(0)
      const [doctor, setDoctor] = useState(null)
      const [doctorError, setDoctorError] = useState(null)
      const [doctorReady, setDoctorReady] = useState(false)
      const [fishIndex, setFishIndex] = useState(null)
      const [fishIndexError, setFishIndexError] = useState(null)
      const [fishReady, setFishReady] = useState(false)
      const [fishAsOf, setFishAsOf] = useState(null)
      const [fishSourceId, setFishSourceId] = useState(null)
      const [fishOverview, setFishOverview] = useState({ state: 'unknown', kind: null, message: '', data: null })
      const [fishCheckpoints, setFishCheckpoints] = useState({
        state: 'idle',
        kind: null,
        message: '',
        data: null,
        sourceId: null,
      })
      const [timelineTotal, setTimelineTotal] = useState(null)
      const [timelineHasMore, setTimelineHasMore] = useState(false)
      const [timelineReady, setTimelineReady] = useState(false)
      const [timelineLoadingMore, setTimelineLoadingMore] = useState(false)
      const [restore, setRestore] = useState(null)
      const selectedCaseId = selectedCase !== null && selectedCase.id !== undefined && selectedCase.id !== null
        ? String(selectedCase.id)
        : null
      const timelineCursorRef = useRef('0')
      const timelineEventsRef = useRef([])
      const timelineHasMoreRef = useRef(false)
      const timelineManualAbortRef = useRef(null)
      const timelineManualBusyRef = useRef(false)
      const drawerRef = useRef(null)
      const writeAbortRef = useRef(null)
      const restoreAbortRef = useRef(null)
      const restoreTokenRef = useRef(null)
      const restoreRef = useRef(null)
      const closeRestoreRef = useRef(null)
      const restoreDialogRef = useRef(null)
      const aliveRef = useRef(true)
      const locale = currentLocale()
      const restoreOpen = restore !== null
      restoreRef.current = restore

      useEffect(() => {
        aliveRef.current = true
        return () => {
          aliveRef.current = false
          if (writeAbortRef.current !== null) writeAbortRef.current.abort()
          if (timelineManualAbortRef.current !== null) timelineManualAbortRef.current.abort()
          if (restoreAbortRef.current !== null) restoreAbortRef.current.abort()
          restoreTokenRef.current = null
        }
      }, [])

      // Reset per-run state whenever the selected run changes.
      useEffect(() => {
        setRunDetail(null)
        setRunError(null)
        setTimeline([])
        setTimelineError(null)
        setTimelineTotal(null)
        setTimelineHasMore(false)
        setTimelineReady(false)
        setTimelineLoadingMore(false)
        timelineCursorRef.current = '0'
        timelineEventsRef.current = []
        timelineHasMoreRef.current = false
        if (timelineManualAbortRef.current !== null) {
          timelineManualAbortRef.current.abort()
          timelineManualAbortRef.current = null
        }
        timelineManualBusyRef.current = false
        if (restoreAbortRef.current !== null) {
          restoreAbortRef.current.abort()
          restoreAbortRef.current = null
        }
        restoreTokenRef.current = null
        setRestore(null)
        setCases([])
        setCasesAsOf(null)
        setCasesError(null)
        setCasesReady(false)
        setSelectedCase(null)
        setConfirmAction(null)
        setDisarmReason('')
        setWriteError(null)
        setWriteNotice(null)
      }, [selectedRunId])

      // Reset per-case state when the drawer target changes, but not when the
      // summary object is optimistically updated after an ack.
      useEffect(() => {
        setCaseDetail(null)
        setCaseDetailError(null)
        setCaseDetailLoading(false)
        setAckNote('')
        setAckConfirm(false)
        setAckError(null)
        setAckNotice(null)
        setCloseReason('resolved')
        setCloseConfirm(false)
      }, [selectedCaseId])

      // The approval queue is live for an armed run and read-only for archives.
      // Poll it independently so a guard-queued L3/L4 request surfaces quickly.
      usePolling(async (signal) => {
        try {
          const payload = await apiGet(
            `/runs/${encodeURIComponent(selectedRunId)}/approvals?state=pending`,
            signal,
          )
          setApprovals(asArray(payload?.data?.approvals))
        } catch {
          // A read-only or archived run may not expose a live queue; keep the
          // last known list instead of flashing an error in the write panel.
        }
      }, 5000, selectedRunId === null ? null : `${selectedRunId}:${approvalsRefresh}`)

      useEffect(() => {
        if (selectedRunId === null) setApprovals([])
      }, [selectedRunId])

      // Keep a valid selection when the run list changes. Prefer an armed run.
      useEffect(() => {
        if (runs.length === 0) {
          if (selectedRunId !== null) setSelectedRunId(null)
          return
        }
        if (selectedRunId !== null && runs.some((run) => String(run.runId) === String(selectedRunId))) return
        const preferred = runs.find((run) => run.armed === true) ?? runs[0]
        if (preferred !== undefined && preferred !== null && preferred.runId !== undefined) {
          setSelectedRunId(String(preferred.runId))
        }
      }, [runs, selectedRunId])

      // Keep the fish source selection valid across host/browser refreshes.
      useEffect(() => {
        const ids = []
        for (const source of asArray(fishIndex?.sources)) {
          if (typeof source?.sourceId === 'string' && !ids.includes(source.sourceId)) ids.push(source.sourceId)
        }
        for (const source of asArray(fishOverview.data?.sources)) {
          if (typeof source?.id === 'string' && !ids.includes(source.id)) ids.push(source.id)
        }
        if (ids.length === 0) {
          if (fishSourceId !== null) setFishSourceId(null)
          return
        }
        if (fishSourceId === null || !ids.includes(fishSourceId)) setFishSourceId(ids[0])
      }, [fishIndex, fishOverview.data, fishSourceId])

      // Restore dialog focus management: focus the dialog, trap Tab, close on
      // Escape (except while the restore request is in flight), and restore the
      // button that opened it.
      useEffect(() => {
        if (!restoreOpen) return undefined
        const previous = typeof document !== 'undefined' ? document.activeElement : null
        const node = restoreDialogRef.current
        if (node !== null && typeof node.focus === 'function') node.focus()
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            const current = restoreRef.current
            const busy = current !== null && current.stage === 'executing'
            event.preventDefault()
            event.stopPropagation()
            if (!busy && typeof closeRestoreRef.current === 'function') closeRestoreRef.current()
            return
          }
          if (event.key !== 'Tab' || node === null) return
          const focusable = Array.from(node.querySelectorAll(
            'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
          )).filter((element) => element.offsetParent !== null || element === document.activeElement)
          if (focusable.length === 0) {
            event.preventDefault()
            if (typeof node.focus === 'function') node.focus()
            return
          }
          const first = focusable[0]
          const last = focusable[focusable.length - 1]
          if (event.shiftKey && (document.activeElement === first || document.activeElement === node)) {
            event.preventDefault()
            last.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first.focus()
          }
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => {
          document.removeEventListener('keydown', onKeyDown, true)
          if (previous !== null && previous !== undefined && typeof previous.focus === 'function' && previous.isConnected !== false) {
            try {
              previous.focus()
            } catch {
              // The restore button may have been removed by a refresh.
            }
          }
        }
      }, [restoreOpen])

      // Drawer focus management: focus the panel, trap Tab, close on Escape,
      // and restore the row that opened it.
      useEffect(() => {
        if (selectedCaseId === null) return undefined
        const previous = typeof document !== 'undefined' ? document.activeElement : null
        const node = drawerRef.current
        if (node !== null && typeof node.focus === 'function') node.focus()
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            setSelectedCase(null)
            return
          }
          if (event.key !== 'Tab' || node === null) return
          const focusable = Array.from(node.querySelectorAll(
            'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
          )).filter((element) => element.offsetParent !== null || element === document.activeElement)
          if (focusable.length === 0) {
            event.preventDefault()
            if (typeof node.focus === 'function') node.focus()
            return
          }
          const first = focusable[0]
          const last = focusable[focusable.length - 1]
          if (event.shiftKey && (document.activeElement === first || document.activeElement === node)) {
            event.preventDefault()
            last.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first.focus()
          }
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => {
          document.removeEventListener('keydown', onKeyDown, true)
          if (previous !== null && previous !== undefined && typeof previous.focus === 'function' && previous.isConnected !== false) {
            try {
              previous.focus()
            } catch {
              // The row may have been removed by a refresh.
            }
          }
        }
      }, [selectedCaseId])

      usePolling(async (signal) => {
        try {
          const payload = await apiGet('/health', signal)
          if (signal.aborted) return
          setHealth(payload)
          setHealthError(null)
        } catch (error) {
          if (!signal.aborted && !isAbort(error)) setHealthError(error)
        }
      }, 15000, refreshKey)

      usePolling(async (signal) => {
        try {
          const payload = await apiGet('/runs', signal)
          if (signal.aborted) return
          const list = asArray(payload.data?.runs).filter((run) => run !== null && run !== undefined && typeof run.runId === 'string' && run.runId !== '')
          setRuns(list)
          setRunsAsOf(payload.data?.asOf ?? payload.asOf ?? null)
          setLastRunsAt(Date.now())
          setRunsError(null)
          setRunsReady(true)
        } catch (error) {
          if (!signal.aborted && !isAbort(error)) {
            setRunsError(error)
            setRunsReady(true)
          }
        }
      }, 5000, refreshKey)

      usePolling(async (signal) => {
        try {
          const payload = await apiGet(`/runs/${encodeURIComponent(selectedRunId)}`, signal)
          if (signal.aborted) return
          setRunDetail(payload.data ?? null)
          setRunError(null)
        } catch (error) {
          if (!signal.aborted && !isAbort(error)) setRunError(error)
        }
      }, 3000, selectedRunId !== null ? `${selectedRunId}:${refreshKey}` : null)

      usePolling(async (signal) => {
        if (selectedRunId === null || timelineManualBusyRef.current) return
        // Replay leaves a manual backlog to the "load more" control and only
        // live-tails once caught up. A failed page is retried on the next tick.
        if (tab === 'replay' && timelineHasMoreRef.current && timelineError === null) return
        const maxPages = tab === 'room' ? TIMELINE_MAX_PAGES : 1
        let cursor = timelineCursorRef.current
        let collected = timelineEventsRef.current
        let hasMore = timelineHasMoreRef.current
        let total = null
        try {
          for (let page = 0; page < maxPages && !signal.aborted; page += 1) {
            const payload = await apiGet(
              `/runs/${encodeURIComponent(selectedRunId)}/timeline?since=${encodeURIComponent(cursor)}&limit=${TIMELINE_PAGE_LIMIT}`,
              signal,
            )
            if (signal.aborted) return
            const data = payload.data ?? {}
            const batch = asArray(data.events)
            collected = mergeEvents(collected, batch)
            if (typeof data.total === 'number' && Number.isFinite(data.total)) total = data.total
            // `nextSince` is opaque: echo the server string verbatim. Never
            // parse it, renumber it, or re-sort by per-source seq.
            const next = typeof data.nextSince === 'string' ? data.nextSince : String(data.nextSince ?? cursor)
            const advanced = next !== cursor
            if (advanced) cursor = next
            hasMore = batch.length >= TIMELINE_PAGE_LIMIT && advanced
            if (!advanced || batch.length < TIMELINE_PAGE_LIMIT) break
          }
          if (signal.aborted) return
          if (collected.length > TIMELINE_BUFFER) collected = collected.slice(-TIMELINE_BUFFER)
          timelineCursorRef.current = cursor
          timelineEventsRef.current = collected
          timelineHasMoreRef.current = hasMore
          setTimeline(collected)
          setTimelineTotal(total)
          setTimelineHasMore(hasMore)
          setTimelineError(null)
          setTimelineReady(true)
        } catch (error) {
          if (!signal.aborted && !isAbort(error)) {
            setTimelineError(error)
            setTimelineReady(true)
          }
        }
      }, TIMELINE_POLL_MS, selectedRunId !== null && (tab === 'room' || tab === 'replay')
        ? `${selectedRunId}:${tab}:${refreshKey}`
        : null)

      // Doctor is polled by its own effect; a slow or failing doctor route must
      // never delay the run overview or the timeline.
      usePolling(async (signal) => {
        try {
          const payload = await apiGetRaw('/doctor', signal)
          if (signal.aborted) return
          const data = payload.data !== null && payload.data !== undefined
            && typeof payload.data === 'object' && !Array.isArray(payload.data)
            ? payload.data
            : payload
          const checks = asArray(data?.checks).filter((check) => check !== null && typeof check === 'object')
          setDoctor({
            ok: payload.ok === true,
            checks,
            asOf: data?.asOf ?? payload.asOf ?? null,
          })
          setDoctorError(null)
          setDoctorReady(true)
        } catch (error) {
          if (!signal.aborted && !isAbort(error)) {
            setDoctorError(error)
            setDoctorReady(true)
          }
        }
      }, DOCTOR_POLL_MS, tab === 'room' ? refreshKey : null)

      // Host fish index and the fishkeeper browser overview are different data
      // and are fetched once per tick. A browser 401/404/network failure only
      // downgrades the view; the host index stays available.
      usePolling(async (signal) => {
        try {
          const payload = await apiGet('/fish', signal)
          if (signal.aborted) return
          setFishIndex(payload.data ?? null)
          setFishAsOf(payload.asOf ?? payload.data?.asOf ?? null)
          setFishIndexError(null)
          setFishReady(true)
        } catch (error) {
          if (!signal.aborted && !isAbort(error)) {
            setFishIndexError(error)
            setFishReady(true)
          }
        }
        try {
          const overview = await fishkeeperRequest('/overview', { signal })
          if (signal.aborted) return
          setFishOverview({ state: 'available', kind: null, message: '', data: overview })
        } catch (error) {
          if (signal.aborted || isAbort(error)) return
          setFishOverview({
            state: 'unavailable',
            kind: browserFailureKind(error),
            message: typeof error?.message === 'string' ? error.message : '',
            data: null,
          })
        }
      }, FISH_POLL_MS, tab === 'fish' ? refreshKey : null)

      usePolling(async (signal) => {
        try {
          const payload = await fishkeeperRequest(`/checkpoints?source=${encodeURIComponent(fishSourceId)}`, { signal })
          if (signal.aborted) return
          setFishCheckpoints({
            state: 'available',
            kind: null,
            message: '',
            data: payload,
            sourceId: fishSourceId,
          })
        } catch (error) {
          if (signal.aborted || isAbort(error)) return
          setFishCheckpoints({
            state: 'error',
            kind: browserFailureKind(error),
            message: typeof error?.message === 'string' ? error.message : '',
            data: null,
            sourceId: fishSourceId,
          })
        }
      }, FISH_POLL_MS, tab === 'fish' && fishSourceId !== null && fishOverview.state === 'available'
        ? `${fishSourceId}:${refreshKey}`
        : null)

      usePolling(async (signal) => {
        try {
          const payload = await apiGet(
            `/runs/${encodeURIComponent(selectedRunId)}/cases?state=${encodeURIComponent(caseFilter)}&limit=100`,
            signal,
          )
          if (signal.aborted) return
          setCases(asArray(payload.data?.cases))
          setCasesAsOf(payload.data?.asOf ?? payload.asOf ?? null)
          setCasesError(null)
          setCasesReady(true)
        } catch (error) {
          if (!signal.aborted && !isAbort(error)) {
            setCasesError(error)
            setCasesReady(true)
          }
        }
      }, 5000, tab === 'cases' && selectedRunId !== null ? `${selectedRunId}:${caseFilter}:${refreshKey}` : null)

      usePolling(async (signal) => {
        try {
          const payload = await apiGet(
            `/runs/${encodeURIComponent(selectedRunId)}/cases/${encodeURIComponent(selectedCaseId)}`,
            signal,
          )
          if (signal.aborted) return
          setCaseDetail(payload.data ?? null)
          setCaseDetailError(null)
        } catch (error) {
          if (!signal.aborted && !isAbort(error)) setCaseDetailError(error)
        } finally {
          if (!signal.aborted && aliveRef.current) setCaseDetailLoading(false)
        }
      }, 5000, selectedRunId !== null && selectedCaseId !== null ? `${selectedRunId}:${selectedCaseId}:${refreshKey}` : null)

      useEffect(() => {
        if (selectedRunId !== null && selectedCaseId !== null) setCaseDetailLoading(true)
      }, [selectedCaseId, selectedRunId, refreshKey])

      const selectedRun = selectedRunId !== null
        ? runs.find((run) => String(run.runId) === String(selectedRunId)) ?? null
        : null
      const selectedDetail = runDetail !== null && selectedRunId !== null && String(runDetail.runId) === String(selectedRunId)
        ? runDetail
        : null
      const drawerCaseDetail = caseDetail !== null && selectedCaseId !== null && String(caseDetail.case?.id ?? '') === selectedCaseId
        ? caseDetail
        : null

      const refreshAll = () => {
        setWriteError(null)
        setWriteNotice(null)
        setRefreshKey((value) => value + 1)
      }

      const toggleWrite = () => {
        if (writeOpen) {
          setWriteOpen(false)
          setTokenDraft('')
          setTokenError(null)
        } else {
          setWriteOpen(true)
        }
      }

      const selectRun = (runId) => {
        setSelectedRunId(String(runId))
        setSelectedCase(null)
        setTab('room')
      }

      const changeFilter = (next) => {
        if (next === caseFilter) return
        setCaseFilter(next)
        setSelectedCase(null)
        setCases([])
        setCasesReady(false)
        setCasesError(null)
        setCasesAsOf(null)
      }

      const openCase = (entry) => {
        setSelectedCase(entry)
        setCaseDetail(null)
        setCaseDetailError(null)
        setCaseDetailLoading(true)
        setAckConfirm(false)
        setAckError(null)
        setAckNotice(null)
      }

      const onTabKeyDown = (event) => {
        const key = event.key
        if (key !== 'ArrowRight' && key !== 'ArrowLeft' && key !== 'ArrowUp' && key !== 'ArrowDown' && key !== 'Home' && key !== 'End') return
        event.preventDefault()
        const index = TAB_ORDER.indexOf(tab)
        let next = tab
        if (key === 'Home') next = TAB_ORDER[0]
        else if (key === 'End') next = TAB_ORDER[TAB_ORDER.length - 1]
        else if (key === 'ArrowRight' || key === 'ArrowDown') next = TAB_ORDER[(index + 1) % TAB_ORDER.length]
        else next = TAB_ORDER[(index - 1 + TAB_ORDER.length) % TAB_ORDER.length]
        setTab(next)
        if (typeof document !== 'undefined') {
          const node = document.getElementById(`ow-tab-${next}`)
          if (node !== null && typeof node.focus === 'function') node.focus()
        }
      }

      const saveToken = () => {
        if (tokenDraft.length === 0) {
          setTokenError({ code: 'TOKEN_REQUIRED', message: '' })
          return null
        }
        const stored = storeWriteToken(tokenDraft)
        setToken(tokenDraft)
        setTokenDraft('')
        setTokenMemoryOnly(!stored)
        setTokenNotice(stored ? t('tokenSaved') : null)
        setTokenError(null)
        return tokenDraft
      }

      const clearToken = () => {
        if (writeAbortRef.current !== null) writeAbortRef.current.abort()
        removeWriteToken()
        setToken(null)
        setTokenDraft('')
        setTokenMemoryOnly(false)
        setTokenNotice(t('tokenCleared'))
        setTokenError(null)
        setConfirmAction(null)
        return null
      }

      const forgetToken = () => {
        removeWriteToken()
        setToken(null)
        setTokenDraft('')
        setTokenMemoryOnly(false)
        setTokenNotice(null)
      }

      const runWrite = async (key, path, body) => {
        if (token === null) return { ok: false, error: { code: 'TOKEN_REQUIRED', message: '' } }
        if (writeAbortRef.current !== null) writeAbortRef.current.abort()
        const controller = new AbortController()
        writeAbortRef.current = controller
        setWriteBusy(key)
        try {
          const payload = await apiPost(path, body, token, controller.signal)
          if (!aliveRef.current) return { ok: false, aborted: true, error: null }
          return { ok: true, aborted: false, error: null, data: payload?.data ?? null }
        } catch (error) {
          if (controller.signal.aborted || isAbort(error)) return { ok: false, aborted: true, error: null }
          if (error?.status === 401) forgetToken()
          return { ok: false, aborted: false, error }
        } finally {
          if (writeAbortRef.current === controller) writeAbortRef.current = null
          if (aliveRef.current) setWriteBusy(null)
        }
      }

      const confirmWrite = async () => {
        const action = confirmAction
        if (action === null || selectedRunId === null || writeBusy !== null) return
        setConfirmAction(null)
        setWriteError(null)
        setWriteNotice(null)
        const base = `/runs/${encodeURIComponent(selectedRunId)}`
        const result = action.kind === 'arm'
          ? await runWrite('arm', `${base}/arm`, { mode: action.mode })
          : action.kind === 'disarm'
            ? await runWrite('disarm', `${base}/disarm`, {
                reason: disarmReason.trim() === '' ? undefined : disarmReason.trim(),
              })
            : action.kind === 'resume'
              ? await runWrite('resume', `${base}/resume`, { reason: 'resumed from the panel' })
              : await runWrite('purge', `${base}/purge`, {
                  confirm: `PURGE ${selectedRunId}`,
                  reason: 'purged from the panel',
                })
        if (result.aborted) return
        if (result.ok) {
          setWriteNotice(action.kind === 'arm'
            ? t('armSuccess')
            : action.kind === 'disarm'
              ? t('disarmSuccess')
              : action.kind === 'resume'
                ? t('resumeSuccess')
                : t('purgeSuccess'))
          if (action.kind === 'disarm') setDisarmReason('')
          if (action.kind === 'purge') {
            setRuns((current) => current.filter((run) => String(run.runId) !== String(selectedRunId)))
            setSelectedRunId(null)
            setSelectedCase(null)
            setApprovals([])
          } else {
            // Reflect the accepted write immediately; the next /runs poll is
            // authoritative and will correct any optimistic mismatch.
            const armed = action.kind === 'arm'
            const state = action.kind === 'resume' ? 'watching' : armed ? 'watching' : 'disarmed'
            setRuns((current) => current.map((run) => String(run.runId) === String(selectedRunId)
              ? { ...run, armed, state, throttle: action.kind === 'resume' ? null : run.throttle }
              : run))
            setRunDetail((current) => current !== null && String(current.runId) === String(selectedRunId)
              ? { ...current, armed, state, throttle: action.kind === 'resume' ? null : current.throttle }
              : current)
          }
          setRefreshKey((value) => value + 1)
        } else {
          setWriteError(result.error)
        }
      }

      const startAck = () => {
        if (selectedCase === null || selectedRunId === null || writeBusy !== null) return
        setAckConfirm(true)
      }

      const confirmAck = async () => {
        if (selectedCase === null || selectedRunId === null || writeBusy !== null) return
        const caseId = selectedCaseId
        if (caseId === null) return
        setAckConfirm(false)
        setAckError(null)
        setAckNotice(null)
        const result = await runWrite(
          `ack:${caseId}`,
          `/runs/${encodeURIComponent(selectedRunId)}/cases/${encodeURIComponent(caseId)}/ack`,
          { note: ackNote.trim() === '' ? undefined : ackNote.trim() },
        )
        if (result.aborted) return
        if (result.ok) {
          setAckNotice(t('ackSuccess'))
          setAckNote('')
          // The ack route may only mark the case as acknowledged, not closed.
          // Hide the action immediately so the operator cannot double-submit.
          setSelectedCase((current) => current === null || String(current.id ?? '') !== caseId
            ? current
            : { ...current, state: 'acknowledged' })
          setCaseDetail((current) => current === null || String(current.case?.id ?? '') !== caseId
            ? current
            : { ...current, case: { ...(current.case ?? {}), state: 'acknowledged' } })
          setRefreshKey((value) => value + 1)
        } else {
          setAckError(result.error)
        }
      }

      const startCloseCase = () => {
        if (selectedCase === null || selectedRunId === null || writeBusy !== null) return
        setCloseConfirm(true)
      }

      const confirmCloseCase = async () => {
        if (selectedCase === null || selectedRunId === null || writeBusy !== null) return
        const caseId = selectedCaseId
        if (caseId === null) return
        setCloseConfirm(false)
        setAckError(null)
        setAckNotice(null)
        const result = await runWrite(
          `close:${caseId}`,
          `/runs/${encodeURIComponent(selectedRunId)}/cases/${encodeURIComponent(caseId)}/close`,
          {
            reason: closeReason,
            note: ackNote.trim() === '' ? undefined : ackNote.trim(),
          },
        )
        if (result.aborted) return
        if (result.ok) {
          setAckNotice(t('closeSuccess'))
          setAckNote('')
          setSelectedCase((current) => current === null || String(current.id ?? '') !== caseId
            ? current
            : { ...current, state: 'closed' })
          setCaseDetail((current) => current === null || String(current.case?.id ?? '') !== caseId
            ? current
            : { ...current, case: { ...(current.case ?? {}), state: 'closed' } })
          setRefreshKey((value) => value + 1)
        } else {
          setAckError(result.error)
        }
      }

      const decideApproval = async (approvalId, action) => {
        if (token === null || selectedRunId === null || writeBusy !== null) return
        setWriteError(null)
        setWriteNotice(null)
        const base = `/runs/${encodeURIComponent(selectedRunId)}/approvals/${encodeURIComponent(approvalId)}`
        if (writeAbortRef.current !== null) writeAbortRef.current.abort()
        const controller = new AbortController()
        writeAbortRef.current = controller
        setWriteBusy(`${action}:${approvalId}`)
        try {
          const note = ackNote.trim() === '' ? undefined : ackNote.trim()
          if (action === 'approve') {
            // The one-time token is minted for this approval, kept in memory, and
            // consumed immediately by the approve call; it never touches storage.
            const challenge = await apiPost(`${base}/challenge`, {}, token, controller.signal)
            const oneTime = challenge?.data?.token
            if (typeof oneTime !== 'string' || oneTime === '') {
              throw Object.assign(new Error('the server did not return a one-time token'), { code: 'APPROVAL_TOKEN_REQUIRED' })
            }
            await apiPost(`${base}/approve`, { token: oneTime, note }, token, controller.signal)
          } else {
            await apiPost(`${base}/reject`, { reason: note ?? 'rejected from the panel' }, token, controller.signal)
          }
          if (!aliveRef.current) return
          setWriteNotice(action === 'approve' ? t('approvalSuccess') : t('approvalRejected'))
          setApprovals((current) => current.filter((approval) => String(approval.id) !== String(approvalId)))
          setApprovalsRefresh((value) => value + 1)
          setRefreshKey((value) => value + 1)
        } catch (error) {
          if (controller.signal.aborted || isAbort(error)) return
          if (error?.status === 401) forgetToken()
          if (aliveRef.current) setWriteError(error)
        } finally {
          if (writeAbortRef.current === controller) writeAbortRef.current = null
          if (aliveRef.current) setWriteBusy(null)
        }
      }

      const closeRestore = () => {
        const current = restoreRef.current
        if (current !== null && current.stage === 'executing') return
        // Do not abort a result-recording request: the restore already ran, and
        // the overwatch evidence write must be allowed to finish. Its state
        // updates are guarded against a null dialog.
        const keepRecording = current !== null
          && (current.stage === 'result' || current.stage === 'error')
          && current.resultRecord === 'recording'
        if (!keepRecording && restoreAbortRef.current !== null) {
          restoreAbortRef.current.abort()
          restoreAbortRef.current = null
        }
        // The fishkeeper confirm token is memory-only and dies with the dialog.
        restoreTokenRef.current = null
        setRestore(null)
      }
      closeRestoreRef.current = closeRestore

      const postRestoreRecord = async (phase, context, controller, extra) => {
        if (selectedRunId === null) {
          const error = new Error('')
          error.code = 'RUN_NOT_ARMED'
          throw error
        }
        if (token === null) {
          const error = new Error('')
          error.code = 'TOKEN_REQUIRED'
          throw error
        }
        const body = {
          sourceId: context.sourceId,
          checkpointId: context.checkpointId,
          phase,
          files: asArray(context.restorable).map((file) => file?.path).filter((path) => typeof path === 'string'),
          warnings: asArray(context.warnings).filter((warning) => typeof warning === 'string'),
        }
        if (phase === 'result') {
          const result = extra?.result
          body.result = {
            ok: result?.ok === true,
            files: asArray(result?.files).map((file) => ({
              path: typeof file?.path === 'string' ? file.path : '',
              ok: file?.ok === true,
              sha256: typeof file?.sha256 === 'string' ? file.sha256 : null,
            })),
            error: typeof result?.error === 'string' && result.error !== '' ? result.error : null,
          }
        }
        try {
          // The restore already ran: a result record must survive tab unload or
          // navigation, so it is sent with keepalive and without the abort signal.
          if (phase === 'result') {
            await apiPost(`/runs/${encodeURIComponent(selectedRunId)}/restores`, body, token, undefined, true)
          } else {
            await apiPost(`/runs/${encodeURIComponent(selectedRunId)}/restores`, body, token, controller.signal)
          }
        } catch (error) {
          if (error?.status === 401) forgetToken()
          throw error
        }
      }

      const beginRestore = async (sourceId, checkpointId) => {
        if (typeof sourceId !== 'string' || typeof checkpointId !== 'string') return
        if (restoreAbortRef.current !== null) restoreAbortRef.current.abort()
        const controller = new AbortController()
        restoreAbortRef.current = controller
        restoreTokenRef.current = null
        setRestore({
          stage: 'preflight',
          sourceId,
          checkpointId,
          sourceName: undefined,
          files: [],
          restorable: [],
          staleFiles: [],
          warnings: [],
          overrideStale: false,
          intentStatus: 'idle',
          intentError: null,
          executeError: null,
          preflightError: null,
          result: null,
          resultRecord: 'idle',
          resultRecordError: null,
        })
        try {
          const plan = await fishkeeperRequest('/checkpoint/restore', {
            method: 'POST',
            body: { id: checkpointId },
            signal: controller.signal,
          })
          if (controller.signal.aborted) return
          const files = asArray(plan.files)
          const restorable = files.filter((file) => file?.action === 'restore')
          const staleFiles = restorable
            .filter((file) => file?.stale === true)
            .map((file) => file?.path)
            .filter((path) => typeof path === 'string')
          const warnings = asArray(plan.warnings).filter((warning) => typeof warning === 'string')
          const resolvedSourceId = typeof plan.sourceId === 'string' ? plan.sourceId : sourceId
          const context = {
            stage: 'confirm',
            sourceId: resolvedSourceId,
            checkpointId: typeof plan.checkpointId === 'string' ? plan.checkpointId : checkpointId,
            sourceName: typeof plan.sourceName === 'string' ? plan.sourceName : undefined,
            files,
            restorable,
            staleFiles,
            warnings,
            overrideStale: false,
            intentStatus: restorable.length === 0 ? 'idle' : 'recording',
            intentError: null,
            executeError: null,
            preflightError: null,
            result: null,
            resultRecord: 'idle',
            resultRecordError: null,
          }
          const planToken = typeof plan.confirmToken === 'string' ? plan.confirmToken : ''
          // Memory only: never sessionStorage/localStorage, URL, logs, or render.
          restoreTokenRef.current = planToken
          if (restorable.length > 0 && planToken === '') {
            // Every execute path must send the fishkeeper-issued token; there is
            // nothing for overwatch to generate or invent.
            setRestore({
              ...context,
              stage: 'error',
              preflightError: { code: 'fishkeeper/confirm-invalid', message: '' },
            })
            return
          }
          setRestore(context)
          if (restorable.length === 0) return
          try {
            await postRestoreRecord('intent', context, controller)
            if (!controller.signal.aborted) {
              setRestore((current) => current !== null && current.stage === 'confirm'
                ? { ...current, intentStatus: 'recorded' }
                : current)
            }
          } catch (error) {
            if (!controller.signal.aborted && !isAbort(error)) {
              setRestore((current) => current !== null && current.stage === 'confirm'
                ? { ...current, intentStatus: 'error', intentError: error }
                : current)
            }
          }
        } catch (error) {
          if (controller.signal.aborted || isAbort(error)) return
          setRestore((current) => current === null ? current : { ...current, stage: 'error', preflightError: error })
        } finally {
          if (restoreAbortRef.current === controller) restoreAbortRef.current = null
        }
      }

      const retryRestorePreflight = () => {
        const current = restoreRef.current
        if (current === null) return
        void beginRestore(current.sourceId, current.checkpointId)
      }

      const retryRestoreIntent = async () => {
        const current = restoreRef.current
        if (current === null) return
        if (restoreAbortRef.current !== null) restoreAbortRef.current.abort()
        const controller = new AbortController()
        restoreAbortRef.current = controller
        setRestore((value) => value === null ? value : { ...value, intentStatus: 'recording', intentError: null })
        try {
          await postRestoreRecord('intent', current, controller)
          if (!controller.signal.aborted) {
            setRestore((value) => value === null ? value : { ...value, intentStatus: 'recorded' })
          }
        } catch (error) {
          if (!controller.signal.aborted && !isAbort(error)) {
            setRestore((value) => value === null ? value : { ...value, intentStatus: 'error', intentError: error })
          }
        } finally {
          if (restoreAbortRef.current === controller) restoreAbortRef.current = null
        }
      }

      const confirmRestore = async () => {
        const current = restoreRef.current
        if (current === null || current.stage !== 'confirm' || current.intentStatus !== 'recorded') return
        if (current.restorable.length === 0) return
        if (current.staleFiles.length > 0 && current.overrideStale !== true) return
        if (token === null || selectedRunId === null) {
          // Never perform a restore whose evidence could not be recorded.
          setRestore((value) => value === null ? value : {
            ...value,
            stage: 'error',
            preflightError: { code: 'TOKEN_REQUIRED', message: '' },
          })
          return
        }
        if (restoreTokenRef.current === null || restoreTokenRef.current === '') {
          setRestore((value) => value === null ? value : {
            ...value,
            stage: 'error',
            preflightError: { code: 'fishkeeper/confirm-invalid', message: '' },
          })
          return
        }
        if (restoreAbortRef.current !== null) restoreAbortRef.current.abort()
        const controller = new AbortController()
        restoreAbortRef.current = controller
        setRestore({ ...current, stage: 'executing', executeError: null })
        try {
          const result = await fishkeeperRequest('/checkpoint/restore', {
            method: 'POST',
            body: {
              id: current.checkpointId,
              dryRun: false,
              confirmToken: restoreTokenRef.current,
              overrideStale: current.overrideStale === true,
              files: current.restorable.map((file) => file.path),
            },
            signal: controller.signal,
          })
          if (controller.signal.aborted) return
          // The one-time token has been consumed; drop it before anything else.
          restoreTokenRef.current = null
          setRestore({
            ...current,
            stage: 'result',
            executeError: null,
            result,
            resultRecord: 'recording',
            resultRecordError: null,
          })
          try {
            await postRestoreRecord('result', current, controller, { result })
            if (!controller.signal.aborted) {
              setRestore((value) => value !== null && value.stage === 'result'
                ? { ...value, resultRecord: 'recorded' }
                : value)
            }
          } catch (error) {
            if (!controller.signal.aborted && !isAbort(error)) {
              setRestore((value) => value !== null && value.stage === 'result'
                ? { ...value, resultRecord: 'error', resultRecordError: error }
                : value)
            }
          }
        } catch (error) {
          if (controller.signal.aborted || isAbort(error)) return
          // A failed execute consumes the token, so force a fresh preflight.
          // Still record a result: the overwatch evidence must show the failure.
          restoreTokenRef.current = null
          const failedResult = {
            ok: false,
            files: [],
            error: typeof error?.message === 'string' && error.message !== ''
              ? error.message
              : (typeof error?.code === 'string' ? error.code : 'restore failed'),
          }
          setRestore({
            ...current,
            stage: 'error',
            executeError: error,
            result: failedResult,
            resultRecord: 'recording',
            resultRecordError: null,
          })
          try {
            await postRestoreRecord('result', current, controller, { result: failedResult })
            if (!controller.signal.aborted) {
              setRestore((value) => value !== null && value.stage === 'error'
                ? { ...value, resultRecord: 'recorded' }
                : value)
            }
          } catch (recordError) {
            if (!controller.signal.aborted && !isAbort(recordError)) {
              setRestore((value) => value !== null && value.stage === 'error'
                ? { ...value, resultRecord: 'error', resultRecordError: recordError }
                : value)
            }
          }
        } finally {
          if (restoreAbortRef.current === controller) restoreAbortRef.current = null
        }
      }

      const retryRestoreResult = async () => {
        const current = restoreRef.current
        if (current === null || current.result === null) return
        if (restoreAbortRef.current !== null) restoreAbortRef.current.abort()
        const controller = new AbortController()
        restoreAbortRef.current = controller
        setRestore((value) => value === null ? value : { ...value, resultRecord: 'recording', resultRecordError: null })
        try {
          await postRestoreRecord('result', current, controller, { result: current.result })
          if (!controller.signal.aborted) {
            setRestore((value) => value === null ? value : { ...value, resultRecord: 'recorded' })
          }
        } catch (error) {
          if (!controller.signal.aborted && !isAbort(error)) {
            setRestore((value) => value === null ? value : { ...value, resultRecord: 'error', resultRecordError: error })
          }
        } finally {
          if (restoreAbortRef.current === controller) restoreAbortRef.current = null
        }
      }

      const changeRestoreOverride = (value) => {
        setRestore((current) => current === null ? current : { ...current, overrideStale: value === true })
      }

      const loadMoreTimeline = async () => {
        if (selectedRunId === null || timelineManualBusyRef.current) return
        const controller = new AbortController()
        timelineManualAbortRef.current = controller
        timelineManualBusyRef.current = true
        setTimelineLoadingMore(true)
        try {
          const payload = await apiGet(
            `/runs/${encodeURIComponent(selectedRunId)}/timeline?since=${encodeURIComponent(timelineCursorRef.current)}&limit=${TIMELINE_PAGE_LIMIT}`,
            controller.signal,
          )
          if (controller.signal.aborted) return
          const data = payload.data ?? {}
          const batch = asArray(data.events)
          const collected = mergeEvents(timelineEventsRef.current, batch)
          const bounded = collected.length > TIMELINE_BUFFER ? collected.slice(-TIMELINE_BUFFER) : collected
          const next = typeof data.nextSince === 'string' ? data.nextSince : String(data.nextSince ?? timelineCursorRef.current)
          const advanced = next !== timelineCursorRef.current
          timelineCursorRef.current = advanced ? next : timelineCursorRef.current
          timelineEventsRef.current = bounded
          const hasMore = batch.length >= TIMELINE_PAGE_LIMIT && advanced
          timelineHasMoreRef.current = hasMore
          setTimeline(bounded)
          if (typeof data.total === 'number' && Number.isFinite(data.total)) setTimelineTotal(data.total)
          setTimelineHasMore(hasMore)
          setTimelineError(null)
          setTimelineReady(true)
        } catch (error) {
          if (!controller.signal.aborted && !isAbort(error)) setTimelineError(error)
        } finally {
          if (timelineManualAbortRef.current === controller) timelineManualAbortRef.current = null
          timelineManualBusyRef.current = false
          if (aliveRef.current) setTimelineLoadingMore(false)
        }
      }

      const runArmed = selectedDetail !== null ? selectedDetail.armed === true : selectedRun?.armed === true
      const supervisedRun = selectedDetail?.watch?.enabled === true
        || selectedDetail?.mode === 'supervised'
        || selectedRun?.mode === 'supervised'
      const asOfText = hasTime(runsAsOf)
        ? formatTime(runsAsOf)
        : lastRunsAt !== null
          ? formatTime(new Date(lastRunsAt).toISOString())
          : '—'

      // Fish sources are the union of the host index and the fishkeeper
      // browser overview, so a browser-only source never disappears.
      const fishSources = []
      for (const source of asArray(fishIndex?.sources)) {
        if (typeof source?.sourceId !== 'string') continue
        if (fishSources.some((entry) => entry.sourceId === source.sourceId)) continue
        fishSources.push({ sourceId: source.sourceId, host: source, browser: undefined })
      }
      for (const source of asArray(fishOverview.data?.sources)) {
        if (typeof source?.id !== 'string') continue
        const existing = fishSources.find((entry) => entry.sourceId === source.id)
        if (existing !== undefined) existing.browser = source
        else fishSources.push({ sourceId: source.id, host: undefined, browser: source })
      }
      const fishSourceIds = fishSources.map((entry) => entry.sourceId)
      const selectedFishSource = fishSources.find((entry) => entry.sourceId === fishSourceId) ?? null
      const hostFishSource = selectedFishSource?.host ?? null
      const browserFishSource = selectedFishSource?.browser ?? null
      const selectedFishCheckpoints = fishCheckpoints.sourceId === fishSourceId
        ? fishCheckpoints
        : { state: 'idle', kind: null, message: '', data: null, sourceId: fishSourceId }
      const restoreCheckpointData = selectedFishCheckpoints.state === 'available' ? selectedFishCheckpoints.data : null
      let restoreDisabledReason = null
      if (fishSourceId === null) restoreDisabledReason = 'fishRestoreNeedBrowser'
      else if (fishOverview.state !== 'available' || restoreCheckpointData === null) restoreDisabledReason = 'fishRestoreNeedBrowser'
      else if (restoreCheckpointData.readOnly === true || browserFishSource?.readOnly === true) restoreDisabledReason = 'fishRestoreNeedReadOnly'
      else if (restoreCheckpointData.restoreSupported !== true) restoreDisabledReason = 'fishRestoreUnsupported'
      else if (selectedRunId === null) restoreDisabledReason = 'fishRestoreNeedRun'
      else if (token === null) restoreDisabledReason = 'fishRestoreNeedToken'
      const fishModel = {
        index: fishIndex,
        hostError: fishIndexError,
        ready: fishReady,
        asOf: fishAsOf ?? fishIndex?.asOf ?? null,
        sourceIds: fishSourceIds,
        sourceId: fishSourceId,
        hostSource: hostFishSource,
        browserSource: browserFishSource,
        checkpoints: mergeCheckpoints(hostFishSource?.checkpoints, restoreCheckpointData?.items),
        overview: fishOverview,
        checkpointsState: selectedFishCheckpoints.state === 'idle' && fishOverview.state === 'available'
          ? { state: 'loading', kind: null, message: '' }
          : selectedFishCheckpoints,
        restoreDisabledReason,
      }

      let body
      if (tab === 'fish') {
        // The fish index is independent of supervised runs: view and audit work
        // even before any run exists. Restore itself still needs a run + token.
        body = h(FishView, {
          model: fishModel,
          restoreBusy: restore !== null,
          onSelectSource: (sourceId) => setFishSourceId(sourceId),
          onRestore: (sourceId, checkpointId) => { void beginRestore(sourceId, checkpointId) },
          onRetry: refreshAll,
          t,
        })
      } else if (!runsReady && runsError === null) {
        body = h('div', { className: 'ow-card ow-state', role: 'status' }, t('loading'))
      } else if (runs.length === 0) {
        body = runsError !== null
          ? h(ErrorNotice, { error: runsError, title: t('errorTitle'), onRetry: refreshAll, t })
          : h(EmptyState, { t })
      } else if (tab === 'room') {
        body = h('div', { className: 'ow-room-grid' },
          h(RunList, { runs, selectedRunId, onSelect: selectRun, t }),
          h('div', { className: 'ow-main-col' },
            h(ErrorNotice, { error: runsError, title: t('errorTitle'), onRetry: refreshAll, t }),
            selectedRun === null
              ? h('div', { className: 'ow-card ow-state' }, t('noRunSelected'))
              : h(RunOverview, {
                  run: selectedRun,
                  detail: selectedDetail,
                  error: runError,
                  onOpenCases: () => {
                    setCaseFilter('open')
                    setTab('cases')
                  },
                  onRetry: refreshAll,
                  t,
                }),
            h(IntegrityCard, {
              health,
              detail: selectedDetail,
              error: healthError,
              selectedRunId,
              doctor,
              doctorError,
              doctorReady,
              onRetry: refreshAll,
              t,
            }),
            h(RecentEvents, {
              events: timeline,
              error: timelineError,
              onRetry: refreshAll,
              t,
            }),
          ),
        )
      } else if (tab === 'cases') {
        body = selectedRun === null
          ? h('div', { className: 'ow-card ow-state' }, t('noRunSelected'))
          : h(CasesPanel, {
              cases,
              filter: caseFilter,
              error: casesError,
              ready: casesReady,
              asOf: casesAsOf,
              onFilter: changeFilter,
              onOpenCase: openCase,
              onRetry: refreshAll,
              t,
            })
      } else {
        body = selectedRun === null
          ? h('div', { className: 'ow-card ow-state' }, t('noRunSelected'))
          : h(ReplayView, {
              runId: selectedRunId,
              events: timeline,
              total: timelineTotal,
              hasMore: timelineHasMore,
              ready: timelineReady,
              error: timelineError,
              loadingMore: timelineLoadingMore,
              onLoadMore: () => { void loadMoreTimeline() },
              onRetry: refreshAll,
              t,
            })
      }

      return h('div', { className: 'ow-root' },
        h('style', null, CSS),
        h('header', { className: 'ow-header' },
          h('div', { className: 'ow-heading' },
            h('div', { className: 'ow-title-row' },
              h('h1', { className: 'ow-title' }, t('pageTitle')),
            ),
            h('p', { className: 'ow-subtitle' }, t('pageSubtitle')),
          ),
          h('div', { className: 'ow-header-actions' },
            h('span', { className: 'ow-meta' }, t('asOf', { time: asOfText })),
            h('button', { type: 'button', className: 'ow-btn ow-btn-small', onClick: refreshAll }, t('refresh')),
            h('button', {
              type: 'button',
              className: `ow-btn ow-btn-small ${writeOpen ? 'ow-btn-active' : ''}`,
              'aria-expanded': writeOpen,
              'aria-controls': writeOpen ? 'ow-write-panel' : undefined,
              onClick: toggleWrite,
            }, writeOpen ? t('writeOpsHide') : t('writeOpsShow')),
          ),
        ),
        h('section', { className: `ow-guard-banner ${supervisedRun ? 'ow-supervised-banner' : ''}`, 'aria-label': supervisedRun ? t('supervisedBanner') : t('guardOnlyBanner') },
          h('span', { className: 'ow-guard-dot', 'aria-hidden': true }),
          h('div', null,
            h('strong', null, supervisedRun ? t('supervisedBanner') : t('guardOnlyBanner')),
            h('p', null, supervisedRun ? t('supervisedHint') : t('guardOnlyHint')),
          ),
        ),
        writeOpen
          ? h(WritePanel, {
              tokenSet: token !== null,
              tokenDraft,
              tokenMemoryOnly,
              tokenNotice,
              tokenError,
              onTokenDraft: (value) => {
                setTokenDraft(value)
                if (tokenError !== null) setTokenError(null)
              },
              onSaveToken: saveToken,
              onClearToken: clearToken,
              onHide: toggleWrite,
              selectedRun,
              runArmed,
              armMode,
              onArmMode: (value) => setArmMode(value === 'observe' ? 'observe' : value === 'supervised' ? 'supervised' : 'guard'),
              disarmReason,
              onDisarmReason: setDisarmReason,
              confirmAction,
              onRequestArm: () => setConfirmAction({ kind: 'arm', mode: armMode }),
              onRequestDisarm: () => setConfirmAction({ kind: 'disarm' }),
              onRequestResume: () => setConfirmAction({ kind: 'resume' }),
              onRequestPurge: () => setConfirmAction({ kind: 'purge' }),
              onConfirm: confirmWrite,
              onCancelConfirm: () => setConfirmAction(null),
              writeBusy,
              writeNotice,
              writeError,
              runStatus: selectedDetail?.status ?? selectedRun?.status ?? null,
              runThrottle: selectedDetail?.throttle ?? selectedRun?.throttle ?? null,
              approvals,
              onApproveApproval: (approvalId) => { void decideApproval(approvalId, 'approve') },
              onRejectApproval: (approvalId) => { void decideApproval(approvalId, 'reject') },
              t,
            })
          : null,
        h('div', { className: 'ow-tabs', role: 'tablist', 'aria-label': t('pageTitle'), onKeyDown: onTabKeyDown },
          TAB_ORDER.map((key) => h('button', {
            key,
            type: 'button',
            id: `ow-tab-${key}`,
            role: 'tab',
            'aria-selected': tab === key,
            'aria-controls': tab === key ? `ow-panel-${key}` : undefined,
            tabIndex: tab === key ? 0 : -1,
            className: 'ow-tab',
            onClick: () => setTab(key),
          },
            t(TAB_LABEL_KEYS[key]),
            key === 'cases' && selectedDetail !== null && typeof selectedDetail.cases?.open === 'number'
              ? h('span', { className: 'ow-tab-count' }, formatNumber(selectedDetail.cases.open))
              : null,
          )),
        ),
        h('div', {
          id: `ow-panel-${tab}`,
          role: 'tabpanel',
          'aria-labelledby': `ow-tab-${tab}`,
          className: 'ow-tab-panel',
        }, body),
        selectedCase !== null
          ? h('div', { className: 'ow-backdrop', onClick: () => setSelectedCase(null) },
              h(CaseDrawer, {
                drawerRef,
                summary: selectedCase,
                detail: drawerCaseDetail,
                detailError: caseDetailError,
                loading: caseDetailLoading,
                tokenSet: token !== null,
                writeOpen,
                writeBusy,
                ackNote,
                ackConfirm,
                ackError,
                ackNotice,
                onAckNote: setAckNote,
                onAckStart: startAck,
                onAckCancel: () => setAckConfirm(false),
                onAck: confirmAck,
                closeReason,
                closeConfirm,
                onCloseReason: setCloseReason,
                onCloseStart: startCloseCase,
                onCloseCancel: () => setCloseConfirm(false),
                onCloseCase: confirmCloseCase,
                onClose: () => setSelectedCase(null),
                t,
              }),
            )
          : null,
        restore !== null
          ? h('div', { className: 'ow-backdrop ow-backdrop-center' },
              h(RestoreDialog, {
                dialogRef: restoreDialogRef,
                restore,
                onConfirm: () => { void confirmRestore() },
                onOverrideChange: changeRestoreOverride,
                onClose: closeRestore,
                onRetryPreflight: retryRestorePreflight,
                onRetryIntent: () => { void retryRestoreIntent() },
                onRetryResult: () => { void retryRestoreResult() },
                t,
              }),
            )
          : null,
      )
    }

    const CSS = `
.ow-root { display: flex; flex-direction: column; gap: 16px; padding: 20px 22px 40px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); min-height: 100%; box-sizing: border-box; overflow: auto; }
.ow-header { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; flex-wrap: wrap; }
.ow-heading { min-width: 0; flex: 1 1 420px; }
.ow-title-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.ow-title { margin: 0; font-size: 22px; font-weight: 650; letter-spacing: -0.01em; }
.ow-subtitle { margin: 4px 0 0; color: var(--dsw-alias-label-secondary); font-size: 13px; max-width: 760px; line-height: 1.5; }
.ow-header-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
.ow-meta { color: var(--dsw-alias-label-secondary); font-size: 11px; white-space: nowrap; }
.ow-guard-banner { display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--dsw-alias-state-warn-secondary, var(--dsw-alias-state-warn-primary)); background: var(--dsw-alias-state-warn-tertiary, color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, transparent)); color: var(--dsw-alias-state-warn-label, var(--dsw-alias-state-warn-primary)); font-size: 12px; line-height: 1.5; }
.ow-guard-banner strong { font-weight: 650; }
.ow-supervised-banner { border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 40%, var(--dsw-alias-border-l1)); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 8%, transparent); }
.ow-supervised-banner .ow-guard-dot { background: var(--dsw-alias-brand-primary); }
.ow-guard-banner p { margin: 2px 0 0; color: var(--dsw-alias-label-secondary); }
.ow-guard-dot { width: 9px; height: 9px; border-radius: 50%; margin-top: 4px; flex: none; background: var(--dsw-alias-state-warn-primary); }
.ow-btn { display: inline-flex; align-items: center; justify-content: center; gap: 4px; padding: 6px 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; line-height: 18px; cursor: pointer; text-decoration: none; }
.ow-btn:hover { background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-border-l2); }
.ow-btn:focus-visible { outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary)); outline-offset: 2px; }
.ow-btn:disabled { opacity: 0.55; cursor: not-allowed; }
.ow-btn-small { font-size: 11px; padding: 4px 8px; line-height: 16px; }
.ow-btn-primary { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: #fff; }
.ow-btn-primary:hover { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); opacity: 0.9; }
.ow-btn-danger { color: var(--dsw-alias-state-error-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, var(--dsw-alias-border-l1)); }
.ow-btn-active { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
.ow-badge { display: inline-flex; align-items: center; gap: 4px; padding: 2px 7px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1); font-size: 10px; line-height: 16px; white-space: nowrap; }
.ow-badge-ok { color: var(--dsw-alias-state-success-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 40%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent); }
.ow-badge-warn { color: var(--dsw-alias-state-warn-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 40%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent); }
.ow-badge-error { color: var(--dsw-alias-state-error-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent); }
.ow-badge-brand { color: var(--dsw-alias-brand-primary); border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 40%, transparent); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, transparent); }
.ow-badge-idle { color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2); }
.ow-tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.ow-tab { appearance: none; border: none; background: transparent; padding: 8px 12px; margin-bottom: -1px; border-bottom: 2px solid transparent; border-radius: 8px 8px 0 0; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 13px; line-height: 20px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; }
.ow-tab:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); }
.ow-tab[aria-selected="true"] { color: var(--dsw-alias-label-primary); border-bottom-color: var(--dsw-alias-brand-primary); }
.ow-tab:focus-visible { outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary)); outline-offset: 2px; }
.ow-tab-count { font-size: 10px; padding: 0 5px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); }
.ow-tab-panel { min-width: 0; }
.ow-room-grid { display: grid; grid-template-columns: minmax(250px, 320px) minmax(0, 1fr); gap: 12px; align-items: start; }
.ow-main-col { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.ow-stack { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.ow-card { padding: 14px 16px; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; min-width: 0; }
.ow-card h2 { margin: 0 0 10px; font-size: 14px; font-weight: 600; }
.ow-card h3 { margin: 0 0 8px; font-size: 11px; font-weight: 600; color: var(--dsw-alias-label-secondary); text-transform: uppercase; letter-spacing: 0.04em; }
.ow-card-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 10px; flex-wrap: wrap; }
.ow-card-head h2, .ow-card-head h3 { margin: 0; }
.ow-subtitle { margin: 2px 0 0; line-height: 1.45; }
.ow-run-groups { display: flex; flex-direction: column; gap: 12px; }
.ow-group-title { margin: 0 0 6px; display: flex; justify-content: space-between; gap: 8px; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--dsw-alias-label-secondary); }
.ow-run-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.ow-run { width: 100%; text-align: left; display: flex; flex-direction: column; gap: 3px; padding: 8px 10px; border-radius: 9px; border: 1px solid transparent; background: var(--dsw-alias-bg-layer-2); color: inherit; font: inherit; cursor: pointer; }
.ow-run:hover { border-color: var(--dsw-alias-border-l2); }
.ow-run[aria-pressed="true"] { border-color: var(--dsw-alias-brand-primary); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 8%, var(--dsw-alias-bg-layer-2)); }
.ow-run:focus-visible { outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary)); outline-offset: 1px; }
.ow-run-id { font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 12px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ow-run-goal { font-size: 11px; color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ow-run-meta { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; font-size: 10px; color: var(--dsw-alias-label-secondary); }
.ow-run-mode { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 150px; }
.ow-run-cases { color: var(--dsw-alias-state-warn-primary); }
.ow-run-budget { margin-left: auto; font-variant-numeric: tabular-nums; }
.ow-run-time { font-size: 10px; color: var(--dsw-alias-label-tertiary); }
.ow-overview-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
.ow-overview-title { min-width: 0; }
.ow-overview-title h2 { margin: 0 0 3px; }
.ow-overview-badges { display: flex; gap: 6px; flex-wrap: wrap; }
.ow-mono { font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 15px; font-weight: 600; overflow-wrap: anywhere; }
.ow-goal { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
.ow-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 8px; margin-bottom: 12px; }
.ow-kpi { padding: 8px 10px; border-radius: 8px; background: var(--dsw-alias-bg-layer-2); min-width: 0; }
.ow-kpi-label { display: block; font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--dsw-alias-label-secondary); }
.ow-kpi-value { display: block; margin-top: 2px; font-size: 13px; font-weight: 600; overflow-wrap: anywhere; }
.ow-kpi-hint { display: block; margin-top: 2px; font-size: 10px; color: var(--dsw-alias-label-tertiary); }
.ow-overview-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px; }
.ow-overview-col { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.ow-budget { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-2); }
.ow-budget-head { display: flex; justify-content: space-between; gap: 8px; font-size: 12px; flex-wrap: wrap; }
.ow-budget-label { font-weight: 600; }
.ow-budget-numbers { color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.ow-budget-track { position: relative; height: 10px; border-radius: 999px; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); overflow: hidden; }
.ow-budget-fill { height: 100%; border-radius: 999px; transition: width 0.2s ease; }
.ow-budget-fill-ok { background: var(--dsw-alias-state-success-primary); }
.ow-budget-fill-warn { background: var(--dsw-alias-state-warn-primary); }
.ow-budget-fill-danger { background: var(--dsw-alias-state-error-primary); }
.ow-budget-fill-idle { background: var(--dsw-alias-state-idle-primary, var(--dsw-alias-label-tertiary)); }
.ow-budget-tick { position: absolute; top: 0; bottom: 0; width: 1px; background: color-mix(in srgb, var(--dsw-alias-label-primary) 70%, transparent); }
.ow-budget-tick-80 { left: 80%; }
.ow-budget-tick-95 { left: 95%; }
.ow-budget-foot { display: flex; justify-content: space-between; gap: 8px; flex-wrap: wrap; font-size: 11px; }
.ow-budget-scale { margin: 0; font-size: 10px; color: var(--dsw-alias-label-tertiary); }
.ow-tone-ok { color: var(--dsw-alias-state-success-primary); }
.ow-tone-warn { color: var(--dsw-alias-state-warn-primary); }
.ow-tone-danger { color: var(--dsw-alias-state-error-primary); }
.ow-tone-error { color: var(--dsw-alias-state-error-primary); }
.ow-tone-idle { color: var(--dsw-alias-label-secondary); }
.ow-tone-muted { color: var(--dsw-alias-label-secondary); }
.ow-freshness { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-2); }
.ow-freshness h3 { margin: 0; }
.ow-chips { display: flex; gap: 6px; flex-wrap: wrap; }
.ow-chip { display: inline-flex; align-items: center; gap: 6px; padding: 3px 8px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1); font-size: 11px; line-height: 18px; background: var(--dsw-alias-bg-layer-1); }
.ow-chip-dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; flex: none; }
.ow-chip-source { font-weight: 600; }
.ow-chip-state { font-weight: 500; }
.ow-chip-meta { color: var(--dsw-alias-label-secondary); font-size: 10px; }
.ow-chip-ok { color: var(--dsw-alias-state-success-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 40%, transparent); }
.ow-chip-stale { color: var(--dsw-alias-state-warn-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 45%, transparent); }
.ow-chip-unavailable { color: var(--dsw-alias-state-error-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 35%, transparent); }
.ow-snapshot { padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-2); }
.ow-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(82px, 1fr)); gap: 6px; }
.ow-stat { padding: 5px 7px; border-radius: 7px; background: var(--dsw-alias-bg-layer-1); font-size: 11px; min-width: 0; }
.ow-stat-label { display: block; color: var(--dsw-alias-label-secondary); font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ow-stat-value { font-weight: 600; font-variant-numeric: tabular-nums; }
.ow-subcard { padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-2); }
.ow-sev-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; margin-bottom: 10px; }
.ow-sev { padding: 7px 8px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); display: flex; flex-direction: column; gap: 1px; }
.ow-sev-code { font-size: 10px; font-weight: 700; letter-spacing: 0.04em; }
.ow-sev-count { font-size: 17px; line-height: 1.15; font-variant-numeric: tabular-nums; }
.ow-sev-meaning { font-size: 10px; color: var(--dsw-alias-label-secondary); }
.ow-sev-l1 { color: var(--dsw-alias-state-business-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 35%, transparent); }
.ow-sev-l2 { color: var(--dsw-alias-state-warn-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 35%, transparent); }
.ow-sev-l3 { color: var(--dsw-alias-state-error-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 30%, transparent); }
.ow-sev-l4 { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, var(--dsw-alias-bg-layer-1)); }
.ow-times { margin-top: 2px; }
.ow-dl { display: flex; flex-direction: column; gap: 6px; margin: 0; }
.ow-dl-row { display: grid; grid-template-columns: minmax(100px, 160px) minmax(0, 1fr); gap: 10px; font-size: 12px; }
.ow-dl dt { color: var(--dsw-alias-label-secondary); }
.ow-dl dd { margin: 0; overflow-wrap: anywhere; }
.ow-muted { color: var(--dsw-alias-label-secondary); }
.ow-small { font-size: 11px; }
.ow-error { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding: 8px 10px; border-radius: 8px; border: 1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 30%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent); color: var(--dsw-alias-state-error-primary); font-size: 12px; line-height: 1.5; }
.ow-error strong { font-weight: 600; }
.ow-error-text { color: var(--dsw-alias-label-primary); overflow-wrap: anywhere; }
.ow-code { font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 10px; padding: 1px 5px; border-radius: 4px; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); overflow-wrap: anywhere; }
.ow-table-wrap { overflow: auto; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; }
.ow-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.ow-table th { text-align: left; padding: 7px 8px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; white-space: nowrap; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.ow-table td { padding: 7px 8px; border-bottom: 1px solid var(--dsw-alias-border-l1); vertical-align: top; }
.ow-table tbody tr:last-child td { border-bottom: none; }
.ow-table tbody tr { cursor: pointer; }
.ow-table tbody tr:hover { background: var(--dsw-alias-bg-layer-2); }
.ow-table tbody tr:focus-within { background: var(--dsw-alias-bg-layer-2); }
.ow-cell-time { white-space: nowrap; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.ow-cell-seq { color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; white-space: nowrap; }
.ow-cell-title { min-width: 150px; }
.ow-row-open { appearance: none; border: 0; padding: 0; margin: 0; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; text-decoration: underline; text-decoration-color: color-mix(in srgb, currentcolor 35%, transparent); text-underline-offset: 2px; }
.ow-row-open:hover { text-decoration-color: currentcolor; }
.ow-row-open:focus-visible { outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary)); outline-offset: 2px; border-radius: 3px; }
.ow-cell-summary { max-width: 460px; overflow-wrap: anywhere; }
.ow-case-table { padding-top: 12px; }
.ow-cases { display: flex; flex-direction: column; gap: 12px; }
.ow-filter { display: inline-flex; gap: 6px; }
.ow-filter .ow-btn[aria-pressed="true"] { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 8%, transparent); }
.ow-inline-meta { display: flex; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.ow-limit { margin: 8px 0 0; }
.ow-empty { text-align: center; padding: 28px 20px; }
.ow-empty h2 { margin: 0 0 6px; font-size: 16px; }
.ow-empty > p { margin: 0 auto 16px; max-width: 700px; color: var(--dsw-alias-label-secondary); line-height: 1.6; font-size: 13px; }
.ow-empty-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 10px; text-align: left; margin-top: 16px; }
.ow-empty-option { padding: 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-2); min-width: 0; }
.ow-empty-option h3 { margin: 0 0 4px; text-transform: none; font-size: 12px; color: var(--dsw-alias-label-primary); }
.ow-empty-option p { margin: 0 0 8px; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.5; }
.ow-code-block { margin: 0; padding: 8px 10px; border-radius: 8px; background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1); overflow: auto; font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 11px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
.ow-state { padding: 32px; text-align: center; color: var(--dsw-alias-label-secondary); }
.ow-write { border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 35%, var(--dsw-alias-border-l1)); }
.ow-actions-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.ow-token-form { display: flex; gap: 8px; align-items: flex-end; flex-wrap: wrap; }
.ow-field { display: flex; flex-direction: column; gap: 4px; flex: 1 1 260px; font-size: 11px; color: var(--dsw-alias-label-secondary); min-width: 0; }
.ow-input, .ow-select, .ow-textarea { font: inherit; font-size: 12px; padding: 6px 8px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); min-width: 0; box-sizing: border-box; }
.ow-textarea { resize: vertical; }
.ow-input:focus-visible, .ow-select:focus-visible, .ow-textarea:focus-visible { outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary)); outline-offset: 1px; }
.ow-token-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.ow-hint { margin: 6px 0 0; font-size: 11px; color: var(--dsw-alias-label-secondary); line-height: 1.5; }
.ow-write-ops { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--dsw-alias-border-l1); }
.ow-write-ops h3 { margin: 0 0 8px; }
.ow-write-controls { display: flex; gap: 8px; align-items: flex-end; flex-wrap: wrap; }
.ow-write-group { display: flex; gap: 8px; align-items: flex-end; flex-wrap: wrap; flex: 1 1 320px; }
.ow-write-group .ow-field { flex: 1 1 200px; }
.ow-confirm { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding: 8px 10px; border-radius: 8px; background: var(--dsw-alias-state-warn-tertiary, color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, transparent)); border: 1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary) 40%, transparent); font-size: 12px; margin-top: 8px; }
.ow-notice { margin: 6px 0 0; font-size: 12px; color: var(--dsw-alias-state-success-primary); }
.ow-ack { display: flex; flex-direction: column; gap: 8px; padding: 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-2); }
.ow-ack h3 { margin: 0; }
.ow-ack-form { display: flex; flex-direction: column; gap: 8px; }
.ow-ack .ow-confirm { margin-top: 0; }
.ow-backdrop { position: fixed; inset: 0; z-index: 70; display: flex; justify-content: flex-end; background: color-mix(in srgb, #000 38%, transparent); }
.ow-drawer { width: min(660px, 100vw); height: 100%; overflow: auto; padding: 18px 20px 28px; box-sizing: border-box; display: flex; flex-direction: column; gap: 14px; background: var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1)); border-left: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-primary); }
.ow-drawer:focus { outline: none; }
.ow-drawer-head { display: flex; justify-content: space-between; gap: 10px; align-items: flex-start; position: sticky; top: 0; z-index: 1; padding-bottom: 8px; background: var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1)); border-bottom: 1px solid var(--dsw-alias-border-l1); }
.ow-drawer-title { margin: 0; font-size: 16px; line-height: 1.4; overflow-wrap: anywhere; }
.ow-drawer-sub { margin: 3px 0 0; color: var(--dsw-alias-label-secondary); font-size: 12px; display: flex; gap: 4px; align-items: center; flex-wrap: wrap; }
.ow-drawer-section { display: flex; flex-direction: column; gap: 8px; }
.ow-drawer-section h3 { margin: 0; }
.ow-signal-list, .ow-evidence-list, .ow-action-list, .ow-decision-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.ow-signal, .ow-evidence { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding: 8px 10px; border-radius: 8px; background: var(--dsw-alias-bg-layer-2); font-size: 12px; }
.ow-action { display: flex; gap: 8px; align-items: flex-start; padding: 8px 10px; border-radius: 8px; background: var(--dsw-alias-bg-layer-2); font-size: 12px; }
.ow-action-dot { width: 8px; height: 8px; border-radius: 50%; margin-top: 5px; flex: none; background: var(--dsw-alias-state-business-primary); }
.ow-action[data-state="verified"] .ow-action-dot { background: var(--dsw-alias-state-success-primary); }
.ow-action[data-state="failed"] .ow-action-dot { background: var(--dsw-alias-state-error-primary); }
.ow-action-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.ow-action-head { display: flex; gap: 6px; flex-wrap: wrap; align-items: baseline; }
.ow-action-time { color: var(--dsw-alias-label-secondary); font-size: 11px; font-variant-numeric: tabular-nums; }
.ow-sr { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.ow-fish { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.ow-fish-errors { margin: 8px 0 0; padding: 8px 10px; border-radius: 8px; border: 1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary) 35%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 8%, transparent); font-size: 12px; line-height: 1.5; }
.ow-fish-errors h3 { margin: 0 0 4px; }
.ow-fish-errors ul { margin: 4px 0 0; padding-left: 18px; display: flex; flex-direction: column; gap: 4px; }
.ow-fish-errors li { display: flex; gap: 6px; align-items: baseline; flex-wrap: wrap; }
.ow-fish-degraded { display: flex; flex-direction: column; gap: 4px; padding: 10px 12px; margin-bottom: 8px; border-radius: 8px; border: 1px dashed color-mix(in srgb, var(--dsw-alias-state-warn-primary) 50%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 7%, transparent); font-size: 12px; line-height: 1.5; }
.ow-fish-degraded p { margin: 0; }
.ow-source-picker { display: flex; gap: 6px; flex-wrap: wrap; }
.ow-source-picker .ow-btn[aria-pressed="true"] { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 8%, transparent); }
.ow-source-chip { display: inline-flex; align-items: center; gap: 4px; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1); font-size: 10px; line-height: 16px; white-space: nowrap; background: var(--dsw-alias-bg-layer-1); }
.ow-source-dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; flex: none; }
.ow-source-swarm { color: var(--dsw-alias-brand-primary); border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 40%, transparent); }
.ow-source-pressure { color: var(--dsw-alias-state-warn-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 40%, transparent); }
.ow-source-watch { color: var(--dsw-alias-state-success-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 40%, transparent); }
.ow-source-fish { color: var(--dsw-alias-label-secondary); }
.ow-source-unknown { color: var(--dsw-alias-label-secondary); }
.ow-legend { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 4px; }
.ow-legend-item { display: inline-flex; align-items: center; gap: 4px; }
.ow-doctor { margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--dsw-alias-border-l1); }
.ow-doctor .ow-card-head { margin-bottom: 6px; }
.ow-dialog { width: min(720px, 100%); max-height: 100%; overflow: auto; margin: auto; padding: 18px 20px 24px; box-sizing: border-box; display: flex; flex-direction: column; gap: 12px; background: var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1)); border: 1px solid var(--dsw-alias-border-l1); border-radius: 14px; color: var(--dsw-alias-label-primary); box-shadow: 0 12px 40px color-mix(in srgb, #000 30%, transparent); }
.ow-dialog:focus { outline: none; }
.ow-dialog-head { display: flex; justify-content: space-between; gap: 10px; align-items: flex-start; }
.ow-dialog-body { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.ow-backdrop-center { align-items: center; justify-content: center; padding: 16px; }
.ow-steps { display: flex; gap: 8px; list-style: none; margin: 0; padding: 0; flex-wrap: wrap; }
.ow-step { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; color: var(--dsw-alias-label-secondary); padding: 3px 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px; }
.ow-step-index { display: inline-flex; align-items: center; justify-content: center; width: 15px; height: 15px; border-radius: 50%; font-size: 9px; background: var(--dsw-alias-bg-layer-2); }
.ow-step-current { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-brand-primary); }
.ow-step-done { color: var(--dsw-alias-state-success-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 40%, transparent); }
.ow-safety { padding: 10px 12px; border: 1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary) 35%, transparent); border-radius: 10px; background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 6%, transparent); }
.ow-safety h3 { margin: 0 0 6px; }
.ow-safety-list { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 4px; font-size: 11px; line-height: 1.6; }
.ow-restore-warnings { padding: 8px 10px; border-radius: 8px; border: 1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary) 40%, transparent); font-size: 12px; line-height: 1.5; }
.ow-restore-warnings ul { margin: 4px 0 0; padding-left: 18px; overflow-wrap: anywhere; }
.ow-restore-stale { display: flex; flex-direction: column; gap: 4px; padding: 8px 10px; border-radius: 8px; border: 1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 7%, transparent); font-size: 12px; line-height: 1.5; }
.ow-restore-stale ul { margin: 0; padding-left: 18px; overflow-wrap: anywhere; }
.ow-check { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; }
.ow-dialog-actions { display: flex; gap: 8px; align-items: center; justify-content: flex-end; flex-wrap: wrap; }
.ow-dialog-actions .ow-hint { margin-right: auto; }
.ow-state-inline { margin: 0; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.ow-restore-intent-error { display: flex; flex-direction: column; gap: 6px; }
.ow-restore-result { border-top: 1px solid var(--dsw-alias-border-l1); padding-top: 10px; }
.ow-replay { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.ow-replay-foot { display: flex; justify-content: center; margin-top: 10px; }
.ow-replay-table td { vertical-align: top; }
@media (max-width: 980px) { .ow-room-grid { grid-template-columns: minmax(0, 1fr); } .ow-overview-grid { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 620px) {
  .ow-root { padding: 14px 12px 28px; }
  .ow-header-actions { width: 100%; justify-content: flex-start; }
  .ow-meta { width: 100%; }
  .ow-sev-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .ow-dl-row { grid-template-columns: minmax(0, 1fr); gap: 2px; }
  .ow-drawer { width: 100vw; padding: 14px 14px 24px; }
  .ow-dialog { width: 100%; padding: 14px 14px 20px; }
  .ow-table th, .ow-table td { padding: 6px; }
}
@media (prefers-reduced-motion: reduce) { .ow-budget-fill { transition: none; } }
`

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        localeService = ctx.locale
        ctx.effect(() => ctx.locale.register(NS, DICT))
        translate = ctx.locale.bind(NS)
        subscribeLocale = (listener) => ctx.locale.subscribe(listener)
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'overwatch',
          order: 40,
          label: () => translate('navLabel'),
        }, navIcon))
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'overwatch',
        }, OverwatchPage))
      },
    }
  },
})
