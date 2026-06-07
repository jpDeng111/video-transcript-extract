const { createElement: h, useEffect, useState } = React;
const { createRoot } = ReactDOM;

const API_BASE = window.location.port === "8000" ? "http://127.0.0.1:3000" : "";
const ANALYTICS_ENDPOINT = `${API_BASE}/api/quittr/analytics`;
const RELAPSE_ENDPOINT = `${API_BASE}/api/quittr/relapses`;

const milestones = [
  { name: "Sprout", days: "0 days", tone: "mint" },
  { name: "Ember", days: "1 days", tone: "ember", active: true },
  { name: "Kindle", days: "2 days", tone: "berry" }
];

const stats = [
  { label: "Goal", value: "7d", icon: "diamond" },
  { label: "Streak", value: "3h 55m", icon: "streak" },
  { label: "Til Sober", value: "90d", icon: "bars" }
];

const quickActions = [
  { label: "Pledge Now", icon: "hand", active: true, action: "pledge" },
  { label: "Melius", icon: "melius", action: "melius" },
  { label: "Urge", icon: "bolt", action: "urge" },
  { label: "Reset", icon: "undo", action: "reset" }
];

const cards = [
  { title: "Rewire by Quittr", subtitle: "1:1 Help from Professionals", icon: "brain", accent: "green", action: "rewire" },
  { title: "Journal", subtitle: "Take a moment to reflect on your journey.", heading: "How are you feeling?", icon: "journal", badge: "1", buttonLabel: "New Entry", accent: "plain", action: "journal" },
  { title: "Reasons For Quitting", subtitle: "Click here to add a reason why you're quitting", icon: "note", accent: "plain", action: "reasons" },
  { title: "Content Blocker", subtitle: "Tap to learn more", icon: "block", accent: "red", pill: "Upgrade", action: "blocker" },
  { title: "Therapy", subtitle: "Get support from a licensed therapist via BetterHelp.", icon: "therapy", accent: "violet", action: "therapy" }
];

const pledgeBenefits = [
  { title: "Achievable Goal", description: "When pledging, you agree to not relapse for the day only.", icon: "check-circle", tone: "green" },
  { title: "Take it Easy", description: "If you relapse, your streak won't reset. Just get back on track and change your mind tomorrow.", icon: "sparkles", tone: "violet" },
  { title: "Success is Inevitable", description: "Stay strong, the first few days/weeks will be tough but after that it'll get easier.", icon: "crown", tone: "gold" }
];

const libraryShortcuts = [
  { label: "Melius", icon: "melius", action: "melius" },
  { label: "Meditate", icon: "meditate", action: "meditate" },
  { label: "Lifetree", icon: "tree", action: "lifetree" }
];

const soundscapes = [
  { title: "Campfire", tone: "campfire" },
  { title: "Ocean", tone: "ocean" },
  { title: "Rain", tone: "rain" },
  { title: "Forest", tone: "forest" }
];

const lessons = [
  { title: "The Neuroscience of Porn Addictio...", status: "Completed", tone: "completed", icon: "check-circle" },
  { title: "Debunking Common Myths A...", status: "Continue learning", tone: "current", icon: "dot" },
  { title: "Psychological and Environmental F...", status: "Locked", tone: "locked", icon: "lock" }
];

const games = [
  { title: "Memory Recall", icon: "brain", tone: "memory" },
  { title: "Find It Fast", icon: "search", tone: "find" },
  { title: "Word Scramble", icon: "letters", tone: "words" }
];

const leaderboardRows = [
  { rank: 1, tone: "gold", width: "34%" },
  { rank: 2, tone: "silver", width: "31%" },
  { rank: 3, tone: "bronze", width: "27%" }
];

const profileBadges = [
  { label: "Starter badge", tone: "earned" },
  { label: "Locked badge", tone: "locked" },
  { label: "Locked badge", tone: "locked" },
  { label: "Locked badge", tone: "locked" },
  { label: "Locked badge", tone: "locked" },
  { label: "Locked badge", tone: "locked" },
  { label: "Locked badge", tone: "locked" }
];

const achievements = [
  { icon: "streak", tone: "ghost", count: "90" },
  { icon: "streak", tone: "ghost", count: "7" },
  { icon: "music", tone: "music" },
  { icon: "block", tone: "block" },
  { icon: "streak", tone: "ghost", count: "30" }
];

const confettiPalette = ["#ffd84d", "#bc46ff", "#52df6c", "#ff5f7b", "#4db7ff", "#ffffff"];
const confettiPieces = Array.from({ length: 26 }, (_, index) => ({
  x: `${-150 + ((index * 29) % 300)}px`,
  y: `${-320 - ((index * 31) % 260)}px`,
  delay: `${(index % 6) * 0.03}s`,
  duration: `${1.25 + (index % 4) * 0.14}s`,
  rotate: `${-200 + (index * 41) % 400}deg`,
  color: confettiPalette[index % confettiPalette.length],
  shape: index % 3 === 0 ? "dot" : index % 3 === 1 ? "strip" : "diamond"
}));

function App() {
  const [page, setPage] = useState("home");
  const [activeTab, setActiveTab] = useState("overview");
  const [lastAction, setLastAction] = useState("");
  const [isPledgeOpen, setIsPledgeOpen] = useState(false);
  const [analytics, setAnalytics] = useState(null);

  useEffect(() => {
    document.body.classList.toggle("modal-open", isPledgeOpen);
    return () => document.body.classList.remove("modal-open");
  }, [isPledgeOpen]);

  useEffect(() => {
    loadAnalytics().then(setAnalytics).catch(() => setLastAction("analytics unavailable"));
  }, []);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [page]);

  async function refreshAnalytics() {
    const data = await loadAnalytics();
    setAnalytics(data);
    return data;
  }

  async function handleAction(action) {
    if (action === "pledge") {
      setIsPledgeOpen(true);
      return;
    }
    if (action === "pledge confirm") {
      setIsPledgeOpen(false);
      launchConfettiBurst();
      showToast("Pledge complete");
      return;
    }
    if (action === "reset") {
      try {
        const data = await recordRelapse();
        setAnalytics(data);
        showToast("Relapse recorded");
      } catch {
        showToast("Reset failed");
      }
      return;
    }
    if (action === "melius") {
      setPage("melius");
      return;
    }
    showToast(`${titleCase(action)} action ready`);
  }

  function showToast(message) {
    setLastAction(message);
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => setLastAction(""), 1500);
  }

  function navigate(nextPage) {
    setPage(nextPage);
    if (nextPage === "analytics") {
      refreshAnalytics().catch(() => showToast("Analytics unavailable"));
    }
  }

  return h(
    "main",
    { className: page === "home" ? "app-shell" : "app-shell page-shell" },
    page === "home" ? h(HomePage, { onAction: handleAction }) : null,
    page === "analytics" ? h(AnalyticsPage, { analytics, activeTab, onTab: setActiveTab, onAction: handleAction }) : null,
    page === "library" ? h(LibraryPage, { onAction: handleAction }) : null,
    page === "profile" ? h(ProfilePage, { onAction: handleAction }) : null,
    page === "melius" ? h(MeliusChatPage, { onBack: () => setPage("analytics") }) : null,
    h(BottomNav, { page, onNavigate: navigate }),
    isPledgeOpen ? h(PledgeModal, { onClose: () => setIsPledgeOpen(false), onAction: handleAction }) : null,
    lastAction ? h("div", { className: "toast", role: "status" }, lastAction) : null
  );
}

function HomePage({ onAction }) {
  return h(
    React.Fragment,
    null,
    h("section", { className: "milestones", "aria-label": "Milestones" }, milestones.map((item) => h(Milestone, { key: item.name, item, onAction }))),
    h("section", { className: "stats-grid", "aria-label": "Recovery stats" }, stats.map((item) => h(StatCard, { key: item.label, item, onAction }))),
    h("section", { className: "quick-grid", "aria-label": "Quick actions" }, quickActions.map((item) => h(QuickAction, { key: item.action, item, onAction }))),
    h(ProgressPill, { onAction }),
    h("section", { className: "card-stack", "aria-label": "Support tools" }, cards.map((card) => h(FeatureCard, { key: card.action, card, onAction }))),
    h(QuoteBlock),
    h("button", { className: "panic-button", type: "button", onClick: () => onAction("panic") }, h(Icon, { name: "warning" }), h("span", null, "Panic Button"))
  );
}

function AnalyticsPage({ analytics, activeTab, onTab, onAction }) {
  const data = analytics || createFallbackAnalytics();

  return h(
    "section",
    { className: "analytics-page" },
    h("h1", null, "Analytics"),
    h("div", { className: "analytics-tabs", role: "tablist" }, ["overview", "stats", "urges"].map((tab) =>
      h("button", { key: tab, className: activeTab === tab ? "analytics-tab is-active" : "analytics-tab", type: "button", onClick: () => onTab(tab) }, titleCase(tab))
    )),
    activeTab === "overview"
      ? h(OverviewPanel, { data, onAction })
      : h("section", { className: "coming-soon" }, h("h2", null, titleCase(activeTab)), h("p", null, "This section is ready for the next feature pass."))
  );
}

function OverviewPanel({ data, onAction }) {
  return h(
    React.Fragment,
    null,
    h(DaysCleanRing, { data }),
    h("button", { className: "melius-card", type: "button", onClick: () => onAction("melius") },
      h("span", { className: "melius-icon" }, h(Icon, { name: "melius" })),
      h("span", { className: "melius-copy" }, h("strong", null, "Talk to Melius"), h("small", null, "Your AI therapist")),
      h("span", { className: "chevron" }, h(Icon, { name: "chevron" }))
    ),
    h(ProgressChart, { points: data.progressPoints }),
    h(StreakJourney, { streaks: data.streaks }),
    h(AnalyticsStats, { stats: data.stats }),
    h("section", { className: "encouragement" }, h("h2", null, data.encouragement.title), h("p", null, data.encouragement.body))
  );
}

function DaysCleanRing({ data }) {
  const days = Number(data.currentStreakDays) || 0;
  const progress = Math.min(0.82, Math.max(0.08, days / 30));
  const circumference = 2 * Math.PI * 84;

  return h(
    "section",
    { className: "days-ring" },
    h("svg", { viewBox: "0 0 220 220", "aria-hidden": "true" },
      h("circle", { className: "ring-track", cx: "110", cy: "110", r: "84" }),
      h("circle", { className: "ring-progress", cx: "110", cy: "110", r: "84", strokeDasharray: `${circumference}`, strokeDashoffset: `${circumference * (1 - progress)}` }),
      h("circle", { className: "ring-dot", cx: "126", cy: "188", r: "11" }),
      h("path", { className: "ring-check", d: "m120 187 5 5 10-12" })
    ),
    h("div", { className: "days-ring-copy" }, h("span", null, "Days Clean"), h("strong", null, data.currentStreakLabel), h("small", null, "Apprentice")),
    h("span", { className: "breakthrough" }, "Breakthrough")
  );
}

function ProgressChart({ points }) {
  const normalized = normalizeChartPoints(points, 360, 170);
  const progressPath = normalized.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ");

  return h(
    "section",
    { className: "chart-section" },
    h("h2", null, "Progress"),
    h("div", { className: "legend" }, h("span", { className: "relapse-key" }, "Relapse"), h("span", { className: "progress-key" }, "Progress")),
    h("svg", { className: "progress-chart", viewBox: "0 0 380 190", role: "img", "aria-label": "Progress chart" },
      [70, 130, 190, 250, 310].map((x) => h("line", { key: x, className: "chart-grid", x1: x, x2: x, y1: "15", y2: "172" })),
      h("path", { className: "chart-fill", d: `${progressPath} L 360 175 L 20 175 Z` }),
      h("path", { className: "progress-line", d: progressPath }),
      normalized.filter((point) => point.type === "relapse").map((point) => h("circle", { key: point.id, className: "relapse-point", cx: point.x, cy: point.y, r: "7" })),
      h("path", { className: "chart-arrow", d: "M 344 86 L 360 80 L 356 96" })
    )
  );
}

function StreakJourney({ streaks }) {
  const visible = streaks.slice(-7);
  const max = Math.max(1, ...visible.map((item) => item.days));

  return h(
    "section",
    { className: "journey-section" },
    h("div", { className: "journey-heading" }, h("span", null, h("h2", null, "Streak Journey"), h("small", null, `${streaks.length} streaks tracked`)), h(Icon, { name: "chevron" })),
    h("div", { className: "legend" }, h("span", { className: "streak-key" }, "Streak"), h("span", { className: "relapse-key" }, "Reset")),
    h("div", { className: "journey-chart" }, visible.map((item) =>
      h("span", { key: item.id, className: "journey-bar-wrap" },
        h("i", { className: item.relapseAt ? "reset-dot" : "reset-dot is-current" }),
        h("b", { style: { height: `${Math.max(8, (item.days / max) * 42)}px` } }),
        h("small", null, Math.round(item.days))
      )
    ))
  );
}

function AnalyticsStats({ stats }) {
  return h(
    "section",
    { className: "analytics-stats" },
    h("div", { className: "metric-circle gold" }, h("span", null, h(Icon, { name: "crown" })), h("strong", null, stats.bestStreakLabel), h("small", null, "Best Streak")),
    h("div", { className: "metric-circle green" }, h("span", null, h(Icon, { name: "stats" })), h("strong", null, stats.avgStreakLabel), h("small", null, "Avg Streak")),
    h("div", { className: "metric-circle red" }, h("span", null, h(Icon, { name: "undo" })), h("strong", null, stats.relapseCount), h("small", null, "Relapses")),
    h("div", { className: "metric-card karma" }, h("strong", null, h(Icon, { name: "heart" }), " ", stats.karma), h("small", null, "Karma")),
    h("div", { className: "metric-card rank" }, h("strong", null, h(Icon, { name: "bars" }), " Top ", stats.rankPercent, "%"), h("small", null, "In QUITTR"))
  );
}

function LibraryPage({ onAction }) {
  return h(
    "section",
    { className: "library-page" },
    h("h1", null, "Library"),
    h("section", { className: "library-shortcuts", "aria-label": "Library shortcuts" }, libraryShortcuts.map((item) => h(LibraryShortcut, { key: item.label, item, onAction }))),
    h(LibraryHeader, { title: "Soundscapes", subtitle: "Relax & drift into a different world to help mitigate urges", action: "soundscapes", onAction }),
    h("section", { className: "soundscape-list", "aria-label": "Soundscapes" }, soundscapes.map((item) => h(SoundscapeButton, { key: item.title, item, onAction }))),
    h("button", { className: "mountain-card", type: "button", onClick: () => onAction("progress mountain") },
      h("span", { className: "mountain-copy" }, h("strong", null, "Progress Mountain"), h("small", null, "Climb the mountain with every day of progress")),
      h("span", { className: "mountain-shape", "aria-hidden": "true" })
    ),
    h(LibraryHeader, { title: "Continue Lesson", subtitle: "Pick up exactly where you left off", action: "lessons", onAction }),
    h("section", { className: "lesson-timeline", "aria-label": "Continue Lesson" }, lessons.map((item) => h(LessonItem, { key: item.title, item, onAction }))),
    h(LibraryHeader, { title: "Games", subtitle: "Defeat urges with cognitive exercises", action: "games", onAction }),
    h("section", { className: "games-row", "aria-label": "Games" }, games.map((item) => h(GameCard, { key: item.title, item, onAction }))),
    h(LibraryHeader, { title: "Leaderboard", action: "leaderboard", onAction }),
    h("button", { className: "leaderboard-card", type: "button", onClick: () => onAction("leaderboard") },
      leaderboardRows.map((row) => h("span", { key: row.rank, className: "leaderboard-row" },
        h("i", { className: row.tone }, row.rank),
        h("b", { style: { width: row.width } }),
        h("em")
      ))
    ),
    h("button", { className: "share-card", type: "button", onClick: () => onAction("share quittr") }, h("strong", null, "Share QUITTR"), h("span", null, "and get rewards"), h("i", null, h(Icon, { name: "gift" })))
  );
}

function LibraryHeader({ title, subtitle, action, onAction }) {
  return h(
    "header",
    { className: "library-section-header" },
    h("span", null, h("h2", null, title), subtitle ? h("p", null, subtitle) : null),
    h("button", { type: "button", "aria-label": `${title} details`, onClick: () => onAction(action) }, h(Icon, { name: "chevron" }))
  );
}

function LibraryShortcut({ item, onAction }) {
  return h("button", { className: "library-shortcut", type: "button", onClick: () => onAction(item.action) }, h("span", null, h(Icon, { name: item.icon })), h("strong", null, item.label));
}

function SoundscapeButton({ item, onAction }) {
  return h("button", { className: `soundscape-card ${item.tone}`, type: "button", onClick: () => onAction(`${item.title} soundscape`) }, h("strong", null, item.title), h("span", null, h(Icon, { name: "play" })));
}

function LessonItem({ item, onAction }) {
  return h(
    "button",
    { className: `lesson-item ${item.tone}`, type: "button", onClick: () => onAction(item.title) },
    h("span", { className: "lesson-step" }, h(Icon, { name: item.icon })),
    h("span", { className: "lesson-copy" }, h("strong", null, item.title), h("small", null, item.status)),
    item.tone === "current" ? h("span", { className: "lesson-next" }, h(Icon, { name: "chevron" })) : null
  );
}

function GameCard({ item, onAction }) {
  return h("button", { className: `game-card ${item.tone}`, type: "button", onClick: () => onAction(item.title) }, h("span", null, h(Icon, { name: item.icon })), h("strong", null, item.title));
}

function ProfilePage({ onAction }) {
  return h(
    "section",
    { className: "profile-page" },
    h("section", { className: "profile-hero", "aria-label": "Profile header" },
      h("div", { className: "profile-actions" },
        h("button", { type: "button", "aria-label": "Share profile", onClick: () => onAction("share profile") }, h(Icon, { name: "share" })),
        h("button", { type: "button", "aria-label": "Profile settings", onClick: () => onAction("profile settings") }, h(Icon, { name: "gear" }))
      ),
      h("div", { className: "profile-avatar-main" }, h(Icon, { name: "profile" }))
    ),
    h("section", { className: "profile-panel" },
      h("button", { className: "edit-profile-button", type: "button", onClick: () => onAction("edit profile") }, "Edit Profile"),
      h("div", { className: "karma-line" }, h(Icon, { name: "diamond" }), h("span", null, "1 Karma")),
      h("section", { className: "badge-row", "aria-label": "Profile badges" }, profileBadges.map((badge, index) =>
        h("button", { key: `${badge.tone}-${index}`, className: `profile-badge ${badge.tone}`, type: "button", "aria-label": badge.label, onClick: () => onAction(badge.label) }, badge.tone === "locked" ? h(Icon, { name: "lock" }) : null)
      )),
      h("header", { className: "profile-section-header" },
        h("h2", null, "Achievements"),
        h("button", { type: "button", "aria-label": "Achievements details", onClick: () => onAction("achievements") }, h(Icon, { name: "chevron" }))
      ),
      h("section", { className: "achievement-row", "aria-label": "Achievements" }, achievements.map((item, index) => h(AchievementBadge, { key: `${item.tone}-${index}`, item, onAction }))),
      h("header", { className: "profile-section-header posts-header" },
        h("span", null, h("h2", null, "My Posts"), h("b", null, "1")),
        h("button", { type: "button", onClick: () => onAction("see all posts") }, "See all ", h(Icon, { name: "chevron" }))
      ),
      h("article", { className: "post-card" },
        h("span", { className: "post-avatar", "aria-hidden": "true" }),
        h("div", { className: "post-body" },
          h("header", null, h("strong", null, "Unknown User"), h("span", null, "·"), h("small", null, "2w ago"), h("button", { type: "button", "aria-label": "Post options", onClick: () => onAction("post options") }, "•••")),
          h("h3", null, "cant stop surfing internet"),
          h("p", null, "whenever i surf the Internet too long the urge come and cant resist"),
          h("footer", null,
            h("button", { type: "button", onClick: () => onAction("comments") }, h(Icon, { name: "comment" }), "0"),
            h("button", { type: "button", onClick: () => onAction("likes") }, h(Icon, { name: "heart-outline" }), "0"),
            h("button", { type: "button", onClick: () => onAction("post stats") }, h(Icon, { name: "stats" }), "1")
          )
        )
      )
    )
  );
}

function AchievementBadge({ item, onAction }) {
  return h(
    "button",
    { className: `achievement-badge ${item.tone}`, type: "button", onClick: () => onAction("achievement") },
    h("span", null, h(Icon, { name: item.icon })),
    item.count ? h("b", null, item.count) : null
  );
}

function MeliusChatPage({ onBack }) {
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState([]);

  function sendMessage(event) {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setMessages([...messages, { role: "user", text }]);
    setDraft("");
  }

  return h(
    "section",
    { className: "chat-page" },
    h("header", { className: "chat-header" }, h("button", { type: "button", onClick: onBack, "aria-label": "Back to analytics" }, h(Icon, { name: "chevron-left" })), h("span", null, h("strong", null, "Melius"), h("small", null, "No saved history"))),
    h("div", { className: "chat-thread" },
      messages.length === 0 ? h("div", { className: "empty-chat" }, h("strong", null, "What feels hardest right now?"), h("p", null, "Start with whatever is on your mind. This chat clears when you leave or refresh.")) : null,
      messages.map((message, index) => h("p", { key: index, className: `chat-bubble ${message.role}` }, message.text))
    ),
    h("form", { className: "chat-composer", onSubmit: sendMessage }, h("input", { value: draft, onChange: (event) => setDraft(event.target.value), placeholder: "Message Melius..." }), h("button", { type: "submit", "aria-label": "Send" }, h(Icon, { name: "send" })))
  );
}

function BottomNav({ page, onNavigate }) {
  const navItems = [
    { label: "Home", icon: "home", page: "home" },
    { label: "Chat", icon: "chat", page: "melius" },
    { label: "Stats", icon: "stats", page: "analytics" },
    { label: "Library", icon: "folder", page: "library" },
    { label: "Profile", icon: "profile", page: "profile" }
  ];

  return h("nav", { className: "bottom-nav", "aria-label": "Main navigation" }, navItems.map((item) =>
    h("button", { key: item.label, className: page === item.page ? "nav-button is-active" : "nav-button", type: "button", "aria-label": item.label, onClick: () => onNavigate(item.page) }, h(Icon, { name: item.icon }))
  ));
}

function Milestone({ item, onAction }) {
  return h("button", { className: item.active ? `milestone ${item.tone} is-active` : `milestone ${item.tone}`, type: "button", onClick: () => onAction(item.name.toLowerCase()) }, h("span", { className: "planet" }), h("strong", null, item.name), h("small", null, item.days));
}

function StatCard({ item, onAction }) {
  return h("button", { className: "stat-card", type: "button", onClick: () => onAction(item.label.toLowerCase()) }, h("span", { className: `stat-icon ${item.icon}` }, h(Icon, { name: item.icon })), h("span", { className: "stat-label" }, item.label), h("strong", null, item.value));
}

function QuickAction({ item, onAction }) {
  return h("button", { className: item.active ? "quick-action is-active" : "quick-action", type: "button", onClick: () => onAction(item.action) }, h("span", { className: "quick-orb" }, h(Icon, { name: item.icon })), h("span", { className: "quick-label" }, item.label));
}

function ProgressPill({ onAction }) {
  return h("button", { className: "progress-pill", type: "button", onClick: () => onAction("brain rewiring") }, h("span", null, "Brain Rewiring"), h("span", { className: "progress-track" }, h("span", { className: "progress-bar" })), h("strong", null, "0%"));
}

function FeatureCard({ card, onAction }) {
  const isJournal = Boolean(card.buttonLabel);
  return h("article", { className: isJournal ? "feature-card journal-card" : "feature-card" }, h("button", { className: "feature-main", type: "button", onClick: () => onAction(card.action) }, h("span", { className: `feature-icon ${card.accent}` }, h(Icon, { name: card.icon })), h("span", { className: "feature-copy" }, h("span", { className: "feature-title-row" }, h("strong", null, card.title), card.pill ? h("em", null, card.pill) : null), card.heading ? h("b", null, card.heading) : null, h("small", null, card.subtitle)), card.badge ? h("span", { className: "badge" }, card.badge) : h("span", { className: "chevron" }, h(Icon, { name: "chevron" }))), card.buttonLabel ? h("button", { className: "entry-button", type: "button", onClick: () => onAction("new entry") }, h(Icon, { name: "edit" }), h("span", null, card.buttonLabel)) : null);
}

function QuoteBlock() {
  return h("section", { className: "quote-block" }, h("span", { className: "quote-mark" }, "\""), h("p", null, "Today marks the beginning of a powerful journey. This decision is a commitment to a better you. Remember, small steps lead to great changes."), h("span", { className: "quote-mark closing" }, "\""));
}

function PledgeModal({ onClose, onAction }) {
  return h("section", { className: "modal-backdrop", role: "dialog", "aria-modal": "true", "aria-label": "Pledge" }, h("div", { className: "pledge-modal" }, h("button", { className: "modal-close", type: "button", "aria-label": "Close pledge dialog", onClick: onClose }, h(Icon, { name: "close" })), h("h2", { className: "modal-title" }, "Pledge"), h("div", { className: "pledge-hero" }, h("span", { className: "pledge-hand" }, h(Icon, { name: "hand" }))), h("div", { className: "pledge-copy" }, h("h3", null, "Pledge Sobriety Today"), h("p", null, "Make a commitment to yourself not to masturbate for today. You'll receive a notification in 24 hours to check in and see how you did.")), h("section", { className: "pledge-benefits" }, pledgeBenefits.map((item) => h(PledgeBenefit, { key: item.title, item }))), h("button", { className: "pledge-cta", type: "button", onClick: () => onAction("pledge confirm") }, "Pledge Now")));
}

function PledgeBenefit({ item }) {
  return h("article", { className: "pledge-benefit" }, h("span", { className: `pledge-benefit-icon ${item.tone}` }, h(Icon, { name: item.icon })), h("span", { className: "pledge-benefit-copy" }, h("strong", null, item.title), h("small", null, item.description)));
}

async function loadAnalytics() {
  const response = await fetch(ANALYTICS_ENDPOINT);
  if (!response.ok) throw new Error("Analytics request failed");
  return response.json();
}

async function recordRelapse() {
  const response = await fetch(RELAPSE_ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  if (!response.ok) throw new Error("Relapse request failed");
  return response.json();
}

function normalizeChartPoints(points, width, height) {
  const items = points && points.length ? points : [{ id: 1, days: 0, type: "progress" }];
  const max = Math.max(1, ...items.map((item) => Number(item.days) || 0));
  return items.map((item, index) => ({
    ...item,
    x: 20 + (index / Math.max(1, items.length - 1)) * (width - 40),
    y: 172 - ((Number(item.days) || 0) / max) * (height - 42)
  }));
}

function createFallbackAnalytics() {
  return {
    currentStreakDays: 7,
    currentStreakLabel: "7d",
    progressPoints: [{ id: 1, days: 8, type: "relapse" }, { id: 2, days: 1, type: "relapse" }, { id: 3, days: 4, type: "relapse" }, { id: 4, days: 2, type: "relapse" }, { id: 5, days: 7, type: "progress" }],
    streaks: [{ id: 1, days: 1, relapseAt: true }, { id: 2, days: 0.5, relapseAt: true }, { id: 3, days: 3, relapseAt: true }, { id: 4, days: 0.7, relapseAt: true }, { id: 5, days: 8, relapseAt: true }, { id: 6, days: 0.4, relapseAt: true }, { id: 7, days: 7, relapseAt: null, current: true }],
    stats: { bestStreakLabel: "8d", avgStreakLabel: "3d", relapseCount: 6, rankPercent: 40, karma: 1 },
    encouragement: { title: "One Week Strong!", body: "A full week is a major milestone. Your brain is beginning to heal. You might notice improved focus and energy. This is just the beginning." }
  };
}

function Icon({ name }) {
  const icons = {
    bars: h("svg", { viewBox: "0 0 24 24" }, h("path", { d: "M5 18h14v2H5v-2Zm1-7h4v5H6v-5Zm6-5h4v10h-4V6Zm6 8h4v2h-4v-2Z" })),
    block: h("svg", { viewBox: "0 0 24 24" }, h("path", { d: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 3c1.4 0 2.8.4 3.9 1.2l-9.7 9.7A7 7 0 0 1 12 5Zm0 14a7 7 0 0 1-4-1.2l9.8-9.7A7 7 0 0 1 12 19Z" })),
    bolt: h("svg", { viewBox: "0 0 24 24" }, h("path", { d: "M13 2 4 14h7l-1 8 10-13h-7l0-7Z" })),
    brain: h("svg", { viewBox: "0 0 24 24" }, h("path", { d: "M8.2 3.7a4 4 0 0 1 6.5 1A4.7 4.7 0 0 1 21 9.1c0 2-.9 3.4-2.2 4.1.1.4.2.8.2 1.2A4.6 4.6 0 0 1 14.4 19H14a3.3 3.3 0 0 1-6.3.3A4.9 4.9 0 0 1 3 14.4c0-1 .3-2 .8-2.8A4.6 4.6 0 0 1 4 4.4a4.8 4.8 0 0 1 4.2-.7Z" })),
    chat: h("svg", { viewBox: "0 0 24 24" }, h("path", { d: "M4 5.5A4.5 4.5 0 0 1 8.5 1h7A4.5 4.5 0 0 1 20 5.5v5.2a4.5 4.5 0 0 1-4.5 4.5H10l-5.5 4.1c-.8.6-1.9 0-1.9-1V5.5H4Z" })),
    chevron: h("svg", { viewBox: "0 0 24 24" }, h("path", { d: "m8.8 4.2 7.1 7.1c.4.4.4 1 0 1.4l-7.1 7.1-1.5-1.5 6.4-6.3-6.4-6.3 1.5-1.5Z" })),
    "chevron-left": h("svg", { viewBox: "0 0 24 24" }, h("path", { d: "m15.2 4.2 1.5 1.5-6.4 6.3 6.4 6.3-1.5 1.5-7.1-7.1a1 1 0 0 1 0-1.4l7.1-7.1Z" })),
    "check-circle": h("svg", { viewBox: "0 0 24 24" }, h("path", { d: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm4.8 7.5-5.4 6.8a1 1 0 0 1-1.5.1l-2.8-2.7 1.4-1.4 2 2 4.7-5.9 1.6 1.1Z" })),
    close: h("svg", { viewBox: "0 0 24 24" }, h("path", { d: "M18.3 4.3 12 10.6 5.7 4.3 4.3 5.7l6.3 6.3-6.3 6.3 1.4 1.4 6.3-6.3 6.3 6.3 1.4-1.4-6.3-6.3 6.3-6.3-1.4-1.4Z" })),
    comment: h("svg", { viewBox: "0 0 24 24" }, h("path", { d: "M5 4h14a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3h-8l-5 4v-4H5a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3Zm0 2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h3v2l2.4-2H19a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1H5Z" })),
    crown: h("svg", { viewBox: "0 0 24 24" }, h("path", { d: "M3 18h18v2H3v-2Zm1.5-11 4.4 3.8L12 4l3.1 6.8L19.5 7 21 16H3L4.5 7Z" })),
    diamond: h("svg", { viewBox: "0 0 24 24" }, h("path", { d: "m12 3 7 9-7 9-7-9 7-9Z" })),
    dot: h("svg", { viewBox: "0 0 24 24" }, h("circle", { cx: "12", cy: "12", r: "5" })),
    edit: h("svg", { viewBox: "0 0 24 24" }, h("path", { d: "M5 17.5V20h2.5L18.8 8.7l-2.5-2.5L5 17.5Z" })),
    folder: h("svg", { viewBox: "0 0 24 24" }, h("path", { d: "M3 6.5A2.5 2.5 0 0 1 5.5 4H10l2 2h6.5A2.5 2.5 0 0 1 21 8.5v8A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5v-10Z" })),
    gear: h("svg", { viewBox: "0 0 24 24" }, h("path", { d: "m19.4 13.5 2.1 1.6-2 3.5-2.6-1a7.6 7.6 0 0 1-1.8 1l-.4 2.8h-4l-.4-2.8a7 7 0 0 1-1.8-1l-2.6 1-2-3.5L6 13.5a7.6 7.6 0 0 1 0-2.1L3.9 9.8l2-3.5 2.6 1c.6-.4 1.2-.7 1.8-1l.4-2.8h4l.4 2.8c.7.2 1.3.6 1.8 1l2.6-1 2 3.5-2.1 1.6a7.6 7.6 0 0 1 0 2.1ZM12.7 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z" })),
    gift: h("svg", { viewBox: "0 0 24 24" }, h("path", { d: "M20 8h-2.2A3.4 3.4 0 0 0 12 4.7 3.4 3.4 0 0 0 6.2 8H4a2 2 0 0 0-2 2v3h2v8h16v-8h2v-3a2 2 0 0 0-2-2ZM9.5 6a1.5 1.5 0 0 1 1.4 2H8.5A1.5 1.5 0 0 1 9.5 6Zm5 0a1.5 1.5 0 0 1 1 2h-2.4A1.5 1.5 0 0 1 14.5 6ZM6 13h5v6H6v-6Zm7 6v-6h5v6h-5Z" })),
    hand: h("svg", { viewBox: "0 0 24 24" }, h("path", { d: "M12 3a1.5 1.5 0 0 1 1.5 1.5V12h1V6a1.5 1.5 0 0 1 3 0v6h1V8a1.5 1.5 0 0 1 3 0v5.4A7.6 7.6 0 0 1 14 21h-1.1a8 8 0 0 1-5.7-2.4L3 14.4c-.7-.7-.7-1.9 0-2.6.7-.7 1.8-.7 2.5-.1L8 14.1V5.5a1.5 1.5 0 0 1 3 0V12h1V4.5A1.5 1.5 0 0 1 12 3Z" })),
    heart: h("svg", { viewBox: "0 0 24 24" }, h("path", { d: "M12 21s-8-4.8-8-11a4.8 4.8 0 0 1 8-3.5A4.8 4.8 0 0 1 20 10c0 6.2-8 11-8 11Z" })),
    "heart-outline": h("svg", { viewBox: "0 0 24 24" }, h("path", { d: "M12 21s-8-4.8-8-11a4.8 4.8 0 0 1 8-3.5A4.8 4.8 0 0 1 20 10c0 6.2-8 11-8 11Zm0-2.4c2-1.4 6-4.8 6-8.6a2.8 2.8 0 0 0-4.7-2.1L12 9.1l-1.3-1.2A2.8 2.8 0 0 0 6 10c0 3.8 4 7.2 6 8.6Z" })),
    home: h("svg", { viewBox: "0 0 24 24" }, h("path", { d: "m12 2 9 7.6V21h-6v-6H9v6H3V9.6L12 2Z" })),
    journal: h("svg", { viewBox: "0 0 24 24" }, h("path", { d: "M6 3h11a2 2 0 0 1 2 2v16H7a3 3 0 0 1-3-3V5a2 2 0 0 1 2-2Z" })),
    letters: h("svg", { viewBox: "0 0 24 24" }, h("path", { d: "M4 19 9.4 5h2.3L17 19h-2.3l-1.1-3H7.4l-1.1 3H4Zm4.1-5h4.8l-2.4-6.5L8.1 14ZM18 6h3v13h-2V8h-1V6Z" })),
    lock: h("svg", { viewBox: "0 0 24 24" }, h("path", { d: "M7 10V8a5 5 0 0 1 10 0v2h1a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h1Zm2 0h6V8a3 3 0 0 0-6 0v2Z" })),
    meditate: h("svg", { viewBox: "0 0 24 24" }, h("path", { d: "M12 6a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Zm-2 2-4 3 1.2 1.6L10 10.5V14l-5 4 1.2 1.6L12 15l5.8 4.6L19 18l-5-4v-3.5l2.8 2.1L18 11l-4-3h-4Zm-8 13h20v2H2v-2Z" })),
    melius: h("svg", { viewBox: "0 0 24 24" }, h("path", { d: "M9 3a7 7 0 0 1 6.8 8.8A6 6 0 1 1 12.2 22a6.9 6.9 0 0 1-2.7-4H9A7.5 7.5 0 0 1 9 3Zm8.5 11a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z" })),
    music: h("svg", { viewBox: "0 0 24 24" }, h("path", { d: "M15 3h4v12.5A3.5 3.5 0 1 1 17 12.3V7h-4v10.5A3.5 3.5 0 1 1 11 14.3V3h4Z" })),
    note: h("svg", { viewBox: "0 0 24 24" }, h("path", { d: "M6 3h12v18H6V3Zm2 2v14h8V5H8Z" })),
    play: h("svg", { viewBox: "0 0 24 24" }, h("path", { d: "M8 5v14l11-7L8 5Z" })),
    profile: h("svg", { viewBox: "0 0 24 24" }, h("path", { d: "M12 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10Zm0 2c-4.4 0-8 2.7-8 6v2h16v-2c0-3.3-3.6-6-8-6Z" })),
    search: h("svg", { viewBox: "0 0 24 24" }, h("path", { d: "M10.5 3a7.5 7.5 0 0 1 5.9 12.1l4.2 4.2-1.4 1.4-4.2-4.2A7.5 7.5 0 1 1 10.5 3Zm0 2a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11Z" })),
    send: h("svg", { viewBox: "0 0 24 24" }, h("path", { d: "M2 21 23 12 2 3v7l12 2-12 2v7Z" })),
    share: h("svg", { viewBox: "0 0 24 24" }, h("path", { d: "M13 3v8h-2V3L7.8 6.2 6.4 4.8 12 0l5.6 4.8-1.4 1.4L13 3ZM5 9h4v2H6v9h12v-9h-3V9h4a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1Z" })),
    sparkles: h("svg", { viewBox: "0 0 24 24" }, h("path", { d: "m12 2 1.7 4.8L18.5 8l-4.8 1.2L12 14l-1.7-4.8L5.5 8l4.8-1.2L12 2Z" })),
    stats: h("svg", { viewBox: "0 0 24 24" }, h("path", { d: "M4 13h4v8H4v-8Zm6-10h4v18h-4V3Zm6 6h4v12h-4V9Z" })),
    streak: h("svg", { viewBox: "0 0 24 24" }, h("path", { d: "M7 14.5a5 5 0 0 0 10 0c0-1.7-.8-3.2-2.4-4.7-.2 1-.9 1.7-1.9 2.3.2-2.4-.7-4.6-2.7-6.6.2 2.5-.7 4.4-2.5 5.7A4.5 4.5 0 0 0 7 14.5Z" })),
    therapy: h("svg", { viewBox: "0 0 24 24" }, h("path", { d: "M8 9h3.2l2.1 2.1a2 2 0 0 0 2.8 0L19 8.2 17.6 6.8 14.7 9.7 12 7H8v2Z" })),
    tree: h("svg", { viewBox: "0 0 24 24" }, h("path", { d: "m12 2 6 8h-3l4 6h-5v5h-4v-5H5l4-6H6l6-8Z" })),
    undo: h("svg", { viewBox: "0 0 24 24" }, h("path", { d: "M9 7V3L2 10l7 7v-4h5.5A4.5 4.5 0 1 1 14.5 4H13V2h1.5a6.5 6.5 0 1 1 0 13H7V7h2Z" })),
    warning: h("svg", { viewBox: "0 0 24 24" }, h("path", { d: "M12 3 1.5 21h21L12 3Zm1 14h-2v2h2v-2Zm0-7h-2v6h2v-6Z" }))
  };
  return icons[name] || null;
}

function launchConfettiBurst() {
  const existingLayer = document.querySelector(".confetti-layer");
  if (existingLayer) existingLayer.remove();
  const layer = document.createElement("div");
  layer.className = "confetti-layer";
  layer.setAttribute("aria-hidden", "true");
  for (const piece of confettiPieces) {
    const node = document.createElement("span");
    node.className = `confetti-piece ${piece.shape}`;
    node.style.left = "50%";
    node.style.top = "58%";
    node.style.animationDelay = piece.delay;
    node.style.animationDuration = piece.duration;
    node.style.background = piece.color;
    node.style.boxShadow = `0 0 14px ${piece.color}66`;
    node.style.setProperty("--confetti-x", piece.x);
    node.style.setProperty("--confetti-y", piece.y);
    node.style.setProperty("--confetti-rotate", piece.rotate);
    layer.appendChild(node);
  }
  document.body.appendChild(layer);
  window.clearTimeout(launchConfettiBurst.timer);
  launchConfettiBurst.timer = window.setTimeout(() => layer.remove(), 2600);
}

function titleCase(value) {
  return value.split(" ").map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`).join(" ");
}

createRoot(document.getElementById("root")).render(h(App));
