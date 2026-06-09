/*
NN Bridge – Visual tweaks + recents filtering for Notebook Navigator

Architecture:
  - CSS toggles: Settings → body class toggles → CSS rules (same as Hider plugin)
  - Recents exclusion: Monkey-patches NN's recentNotesService.recordFileOpen()
    to filter out files at the DATA level (before they reach the virtualizer).
    This avoids the blank-space problem that DOM-level hiding causes with
    TanStack Virtual.
*/

var obsidian = require("obsidian");

// ── Default settings ───────────────────────────────────────────────────
var DEFAULT_SETTINGS = {
    hideShortcutLabels: false,
    hideShortcutsHeader: false,
    hideShortcuts: false,
    hideVaultTitle: false,
    hideNoteCounts: false,
    hideNavBanner: false,
    hideSectionIcons: false,
    hideNavSeparators: false,
    // Recents exclusion
    hideShortcutsFromRecents: false,
    recentsExclusionEnabled: false,
    recentsExclusionList: "",
    // Indentation
    customIndent: false,
    indentDistance: 16,
    hideChevrons: false,
    customChevronSize: false,
    chevronSize: 16,
    customChevronColor: false,
    chevronColor: "",
    // Sidebar embed
    sidebarEmbedEnabled: false,
    sidebarEmbedMarkdown: "",
    sidebarEmbedTitle: "Quick actions",
    sidebarEmbedPosition: "bottom",
    sidebarEmbedAfterSelector: "",
    sidebarEmbedTopSpacing: 8,
    // Sidebar tabs (Notion-like)
    sidebarTabsStyleEnabled: false,
    sidebarTabIconsEnabled: false,
    sidebarTabIcons: "notebook-navigator: menu\nsearch: search",
    sidebarTabCommandsEnabled: false,
    sidebarTabCommands: "New note: file-plus: file-explorer:new-file\nSettings: settings: app:open-settings",
    customSections: [],
    customSectionsPosition: "below-shortcuts",
    customSectionsSelector: "",
};

// ── Setting → body class mapping ───────────────────────────────────────
var CLASS_MAP = {
    hideShortcutLabels:  "nn-bridge-hide-shortcut-labels",
    hideShortcutsHeader: "nn-bridge-hide-shortcuts-header",
    hideShortcuts:       "nn-bridge-hide-shortcuts",
    hideVaultTitle:      "nn-bridge-hide-vault-title",
    hideNoteCounts:      "nn-bridge-hide-note-counts",
    hideNavBanner:       "nn-bridge-hide-nav-banner",
    hideSectionIcons:    "nn-bridge-hide-section-icons",
    hideNavSeparators:   "nn-bridge-hide-nav-separators",
    hideChevrons:        "nn-bridge-hide-chevrons",
    sidebarTabsStyleEnabled: "nn-bridge-sidebar-tabs-style",
};

var COMMAND_SHORTCUT_QUERY_PREFIX = "nn-bridge:command:";
var DEFAULT_COMMAND_SHORTCUT_ICON = "lucide-command";

// ── Main plugin class ──────────────────────────────────────────────────
class NNBridgePlugin extends obsidian.Plugin {

    async onload() {
        await this.loadSettings();
        this.addSettingTab(new NNBridgeSettingTab(this.app, this));
        this._activeMarkdownComponents = [];
        this._refreshDebounceTimer = null;
        this._refreshInFlight = false;
        this._refreshQueued = false;
        this._lastRenderFingerprint = null;
        this.updateStyle();

        this._originalRecordFileOpen = null;
        this._patchApplied = false;
        this._excludedNames = [];
        this._fileOpenRef = null;
        this._commandShortcutRefreshTimer = null;
        this._commandShortcutObserver = null;

        this._customSectionsRefreshTimer = null;

        this.app.workspace.onLayoutReady(() => {
            this._rebuildExclusionList();
            this._applyPatch();
            // Clean existing recents on first load
            this._cleanExistingRecents();
            this._installCommandShortcutBridge();
            this._initializeCommandShortcuts();
            this.refreshSidebarEmbed();
            this._installSidebarTabBridge();
            this.refreshCustomSections();
        });

        this.registerEvent(this.app.workspace.on("layout-change", () => {
            this._applyIndentOverrides();
            this._queueCommandShortcutRefresh();
            this.refreshSidebarEmbed();
            this.refreshCustomSections();
        }));

        this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
            this._handleFileRename(oldPath, file.path);
        }));

        this.registerEvent(this.app.vault.on("delete", (file) => {
            this._handleFileDelete(file.path);
        }));

        this._lastMarkdownLeaf = null;
        this._sidebarBridgeActive = false;
        this._sidebarBridgeTimer = null;
        this._workspaceBridgeShadowedProps = [];
        this.app.workspace.onLayoutReady(() => {
            var initial = this._findMarkdownLeafForCommands();
            if (initial) this._lastMarkdownLeaf = initial;
        });
        this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf) => {
            if (this._isMarkdownLeaf(leaf)) this._lastMarkdownLeaf = leaf;
        }));

        this._installWorkspaceBridge();

        // While a click inside the sidebar embed is dispatched, activate the
        // workspace bridge so Templater (and any plugin that reads the active
        // file/view) resolves against the cached markdown leaf. No visible
        // active-leaf/focus change occurs.
        this.registerDomEvent(document, "pointerdown", (evt) => {
            this._handleSidebarEmbedInteraction(evt);
        }, true);
        this.registerDomEvent(document, "touchstart", (evt) => {
            this._handleSidebarEmbedInteraction(evt);
        }, true);
        this.registerDomEvent(document, "mousedown", (evt) => {
            this._handleSidebarEmbedInteraction(evt);
        }, true);
        this.registerDomEvent(document, "click", (evt) => {
            this._handleSidebarEmbedInteraction(evt);
        }, true);
        this.registerDomEvent(document, "click", (evt) => {
            this._handleCommandShortcutClick(evt);
        }, true);
        this.registerDomEvent(document, "keydown", (evt) => {
            this._handleCommandShortcutKeydown(evt);
        }, true);
        this.registerDomEvent(document, "click", (evt) => {
            this._handleCustomSectionClick(evt);
        }, true);
        this.registerDomEvent(document, "keydown", (evt) => {
            this._handleCustomSectionKeydown(evt);
        }, true);
    }

    onunload() {
        for (var key in CLASS_MAP) {
            document.body.classList.remove(CLASS_MAP[key]);
        }
        this._removePatch();
        // Clean up inline CSS variable overrides
        var containers = document.querySelectorAll(".notebook-navigator");
        containers.forEach(function (el) {
            el.style.removeProperty("--nn-setting-nav-indent");
            el.style.removeProperty("--nn-bridge-chevron-size");
            el.style.removeProperty("--nn-theme-navitem-chevron-color");
        });
        if (this._refreshDebounceTimer) {
            window.clearTimeout(this._refreshDebounceTimer);
            this._refreshDebounceTimer = null;
        }
        if (this._commandShortcutRefreshTimer) {
            window.clearTimeout(this._commandShortcutRefreshTimer);
            this._commandShortcutRefreshTimer = null;
        }
        if (this._customSectionsRefreshTimer) {
            window.clearTimeout(this._customSectionsRefreshTimer);
            this._customSectionsRefreshTimer = null;
        }
        this._removeSidebarEmbeds();
        this._removeCustomSections();
        this._teardownCommandShortcutBridge();
        this._uninstallWorkspaceBridge();
        if (this._sidebarBridgeTimer) {
            window.clearTimeout(this._sidebarBridgeTimer);
            this._sidebarBridgeTimer = null;
        }
        this._teardownSidebarTabBridge();
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    updateStyle() {
        for (var key in CLASS_MAP) {
            document.body.classList.toggle(CLASS_MAP[key], !!this.settings[key]);
        }
        this._applyIndentOverrides();
        this.refreshSidebarEmbed();
    }

    // ── Indentation + Chevron Overrides ─────────────────────────────

    /**
     * Apply CSS variable overrides for indentation and chevron size/color
     * directly on the NN container element(s). This overrides the values
     * NN sets via its own JS, because our rule has higher specificity
     * (inline style on the same element).
     */
    _applyIndentOverrides() {
        // Find all NN root containers
        var containers = document.querySelectorAll(".notebook-navigator");
        var self = this;

        containers.forEach(function (el) {
            // Indent distance
            if (self.settings.customIndent) {
                el.style.setProperty("--nn-setting-nav-indent", self.settings.indentDistance + "px");
            } else {
                el.style.removeProperty("--nn-setting-nav-indent");
            }

            // Chevron size
            if (self.settings.customChevronSize) {
                el.style.setProperty("--nn-bridge-chevron-size", self.settings.chevronSize + "px");
            } else {
                el.style.removeProperty("--nn-bridge-chevron-size");
            }

            // Chevron color
            if (self.settings.customChevronColor && self.settings.chevronColor) {
                el.style.setProperty("--nn-theme-navitem-chevron-color", self.settings.chevronColor);
            } else {
                el.style.removeProperty("--nn-theme-navitem-chevron-color");
            }
        });

        // If containers not found yet (NN hasn't rendered), retry once
        if (containers.length === 0) {
            var retryTimer = window.setTimeout(function () {
                var retry = document.querySelectorAll(".notebook-navigator");
                retry.forEach(function (el) {
                    if (self.settings.customIndent) {
                        el.style.setProperty("--nn-setting-nav-indent", self.settings.indentDistance + "px");
                    }
                    if (self.settings.customChevronSize) {
                        el.style.setProperty("--nn-bridge-chevron-size", self.settings.chevronSize + "px");
                    }
                    if (self.settings.customChevronColor && self.settings.chevronColor) {
                        el.style.setProperty("--nn-theme-navitem-chevron-color", self.settings.chevronColor);
                    }
                });
            }, 2000);
            this.register(function () { window.clearTimeout(retryTimer); });
        }
    }

    // ── NN Plugin Access ───────────────────────────────────────────

    _getNNPlugin() {
        var plugins = this.app.plugins;
        if (!plugins || !plugins.plugins) return null;
        return plugins.plugins["notebook-navigator"] || null;
    }

    _getActiveNNProfileState() {
        var nn = this._getNNPlugin();
        if (!nn || !nn.settings || !Array.isArray(nn.settings.vaultProfiles) || nn.settings.vaultProfiles.length === 0) {
            return null;
        }

        var activeProfileId = typeof nn.settings.vaultProfile === "string" && nn.settings.vaultProfile
            ? nn.settings.vaultProfile
            : nn.settings.vaultProfiles[0].id;
        var profile = null;

        for (var i = 0; i < nn.settings.vaultProfiles.length; i++) {
            if (nn.settings.vaultProfiles[i] && nn.settings.vaultProfiles[i].id === activeProfileId) {
                profile = nn.settings.vaultProfiles[i];
                break;
            }
        }

        if (!profile) {
            profile = nn.settings.vaultProfiles[0] || null;
        }
        if (!profile) {
            return null;
        }
        if (!Array.isArray(profile.shortcuts)) {
            profile.shortcuts = [];
        }

        return {
            nn: nn,
            profile: profile,
        };
    }

    _normalizeCommand(command, fallbackId) {
        if (!command || typeof command !== "object") {
            return null;
        }

        var id = "";
        if (typeof command.id === "string" && command.id.trim()) {
            id = command.id.trim();
        } else if (typeof fallbackId === "string" && fallbackId.trim()) {
            id = fallbackId.trim();
        }
        if (!id) {
            return null;
        }

        var name = "";
        if (typeof command.name === "string" && command.name.trim()) {
            name = command.name.trim();
        } else if (typeof command.displayName === "string" && command.displayName.trim()) {
            name = command.displayName.trim();
        } else {
            name = id;
        }

        return Object.assign({}, command, {
            id: id,
            name: name,
        });
    }

    _getCommandRegistry() {
        var commandsApi = this.app && this.app.commands;
        var commands = [];

        if (commandsApi && typeof commandsApi.listCommands === "function") {
            commands = commandsApi.listCommands() || [];
        } else if (commandsApi && commandsApi.commands) {
            commands = Object.keys(commandsApi.commands).map(function (id) {
                return commandsApi.commands[id];
            });
        }

        var normalizedById = new Map();
        commands.forEach(function (command) {
            var normalized = this._normalizeCommand(command);
            if (!normalized || normalizedById.has(normalized.id)) {
                return;
            }
            normalizedById.set(normalized.id, normalized);
        }, this);

        return Array.from(normalizedById.values())
            .sort(function (a, b) {
                var nameCompare = a.name.localeCompare(b.name);
                return nameCompare !== 0 ? nameCompare : a.id.localeCompare(b.id);
            });
    }

    _getCommandById(commandId) {
        var commandsApi = this.app && this.app.commands;
        if (!commandsApi || !commandsApi.commands || !commandId) {
            return null;
        }
        return this._normalizeCommand(commandsApi.commands[commandId], commandId);
    }

    _encodeCommandShortcutQuery(commandId) {
        return COMMAND_SHORTCUT_QUERY_PREFIX + commandId;
    }

    _decodeCommandShortcutQuery(query) {
        if (typeof query !== "string") {
            return "";
        }
        var trimmed = query.trim();
        if (!trimmed || trimmed.indexOf(COMMAND_SHORTCUT_QUERY_PREFIX) !== 0) {
            return "";
        }
        return trimmed.slice(COMMAND_SHORTCUT_QUERY_PREFIX.length).trim();
    }

    _getCommandShortcutMeta(shortcut) {
        if (!shortcut || typeof shortcut !== "object") {
            return null;
        }

        if (shortcut.type === "command" && typeof shortcut.commandId === "string" && shortcut.commandId.trim()) {
            return {
                commandId: shortcut.commandId.trim(),
                icon: typeof shortcut.icon === "string" && shortcut.icon.trim()
                    ? shortcut.icon.trim()
                    : DEFAULT_COMMAND_SHORTCUT_ICON,
            };
        }

        if (shortcut.type !== "search") {
            return null;
        }

        var commandId = "";
        var icon = "";
        var meta = shortcut.nnBridgeCommand;

        if (meta && typeof meta === "object" && meta.type === "command" &&
            typeof meta.commandId === "string" && meta.commandId.trim()) {
            commandId = meta.commandId.trim();
            if (typeof meta.icon === "string" && meta.icon.trim()) {
                icon = meta.icon.trim();
            }
        }

        if (!commandId) {
            commandId = this._decodeCommandShortcutQuery(shortcut.query);
        }
        if (!commandId) {
            return null;
        }

        if (!icon && typeof shortcut.icon === "string" && shortcut.icon.trim()) {
            icon = shortcut.icon.trim();
        }

        return {
            commandId: commandId,
            icon: icon || DEFAULT_COMMAND_SHORTCUT_ICON,
        };
    }

    _getCommandShortcutLabel(shortcut, fallbackLabel) {
        if (shortcut && typeof shortcut.name === "string" && shortcut.name.trim()) {
            return shortcut.name.trim();
        }
        if (shortcut && typeof shortcut.alias === "string" && shortcut.alias.trim()) {
            return shortcut.alias.trim();
        }
        return typeof fallbackLabel === "string" ? fallbackLabel : "";
    }

    _reserveUniqueCommandShortcutName(usedNames, proposedName) {
        var baseName = typeof proposedName === "string" && proposedName.trim()
            ? proposedName.trim()
            : "Command";
        var normalized = baseName.toLowerCase();

        if (!usedNames.has(normalized)) {
            usedNames.add(normalized);
            return baseName;
        }

        var suffix = 2;
        while (usedNames.has((baseName + " (" + suffix + ")").toLowerCase())) {
            suffix += 1;
        }

        var uniqueName = baseName + " (" + suffix + ")";
        usedNames.add(uniqueName.toLowerCase());
        return uniqueName;
    }

    _getUsedSearchShortcutNames(shortcuts, ignoreIndex) {
        var usedNames = new Set();
        if (!Array.isArray(shortcuts)) {
            return usedNames;
        }

        shortcuts.forEach(function (shortcut, index) {
            if (!shortcut || index === ignoreIndex || shortcut.type !== "search" ||
                typeof shortcut.name !== "string" || !shortcut.name.trim()) {
                return;
            }
            usedNames.add(shortcut.name.trim().toLowerCase());
        });

        return usedNames;
    }

    _buildCommandShortcutCarrier(commandId, label, icon, provider) {
        var normalizedCommandId = typeof commandId === "string" ? commandId.trim() : "";
        var normalizedLabel = typeof label === "string" && label.trim() ? label.trim() : normalizedCommandId;
        var normalizedProvider = typeof provider === "string" && provider.trim() ? provider.trim() : "internal";
        var normalizedIcon = typeof icon === "string" && icon.trim() ? icon.trim() : DEFAULT_COMMAND_SHORTCUT_ICON;

        return {
            type: "search",
            name: normalizedLabel,
            query: this._encodeCommandShortcutQuery(normalizedCommandId),
            provider: normalizedProvider,
            nnBridgeCommand: {
                type: "command",
                commandId: normalizedCommandId,
                icon: normalizedIcon,
            },
        };
    }

    _isSameCommandShortcutCarrier(shortcut, carrier) {
        var meta = this._getCommandShortcutMeta(shortcut);
        if (!meta || !carrier || shortcut.type !== "search") {
            return false;
        }

        var provider = typeof shortcut.provider === "string" && shortcut.provider.trim()
            ? shortcut.provider.trim()
            : "internal";

        return meta.commandId === carrier.nnBridgeCommand.commandId &&
            meta.icon === carrier.nnBridgeCommand.icon &&
            provider === carrier.provider &&
            this._getCommandShortcutLabel(shortcut, "") === carrier.name &&
            this._decodeCommandShortcutQuery(shortcut.query) === carrier.nnBridgeCommand.commandId;
    }

    _getCommandShortcutEntries() {
        var state = this._getActiveNNProfileState();
        if (!state || !Array.isArray(state.profile.shortcuts)) {
            return [];
        }

        var entries = [];
        state.profile.shortcuts.forEach(function (shortcut, index) {
            var meta = this._getCommandShortcutMeta(shortcut);
            if (!meta) {
                return;
            }
            entries.push({
                index: index,
                shortcut: shortcut,
                profile: state.profile,
                nn: state.nn,
                commandId: meta.commandId,
                icon: meta.icon,
                label: this._getCommandShortcutLabel(shortcut, meta.commandId),
            });
        }, this);
        return entries;
    }

    _hasCommandShortcut(commandId) {
        if (!commandId) return false;

        var entries = this._getCommandShortcutEntries();
        for (var i = 0; i < entries.length; i++) {
            if (entries[i].commandId === commandId) {
                return true;
            }
        }
        return false;
    }

    async _saveNNSettings(nn) {
        if (!nn) return false;

        if (typeof nn.saveSettingsAndUpdate === "function") {
            await nn.saveSettingsAndUpdate();
            this._queueCommandShortcutRefresh();
            return true;
        }
        if (typeof nn.saveSettings === "function") {
            await nn.saveSettings();
            if (typeof nn.notifySettingsUpdate === "function") {
                nn.notifySettingsUpdate();
            }
            this._queueCommandShortcutRefresh();
            return true;
        }
        if (typeof nn.saveData === "function" && nn.settings) {
            await nn.saveData(nn.settings);
            if (typeof nn.onSettingsUpdate === "function") {
                nn.onSettingsUpdate();
            }
            this._queueCommandShortcutRefresh();
            return true;
        }

        return false;
    }

    async addCommandShortcut(commandId) {
        if (!commandId) {
            throw new Error("Missing command ID.");
        }

        var state = this._getActiveNNProfileState();
        if (!state) {
            throw new Error("Notebook Navigator is not available.");
        }
        if (this._hasCommandShortcut(commandId)) {
            throw new Error("That command is already pinned in shortcuts.");
        }

        var command = this._getCommandById(commandId);
        if (!command) {
            throw new Error("Command not found.");
        }

        var usedNames = this._getUsedSearchShortcutNames(state.profile.shortcuts, -1);
        var label = this._reserveUniqueCommandShortcutName(usedNames, command.name);

        state.profile.shortcuts.push(this._buildCommandShortcutCarrier(
            command.id,
            label,
            DEFAULT_COMMAND_SHORTCUT_ICON,
            "internal"
        ));

        await this._saveNNSettings(state.nn);
    }

    async updateCommandShortcut(index, updates) {
        var state = this._getActiveNNProfileState();
        if (!state || !Array.isArray(state.profile.shortcuts)) {
            throw new Error("Notebook Navigator is not available.");
        }

        var shortcut = state.profile.shortcuts[index];
        var meta = this._getCommandShortcutMeta(shortcut);
        if (!shortcut || !meta) {
            throw new Error("Command shortcut not found.");
        }

        var command = this._getCommandById(meta.commandId);
        var defaultLabel = command && command.name ? command.name : meta.commandId;
        var labelUpdate = null;

        if (Object.prototype.hasOwnProperty.call(updates, "label")) {
            labelUpdate = updates.label;
        } else if (Object.prototype.hasOwnProperty.call(updates, "alias")) {
            labelUpdate = updates.alias;
        }

        var nextLabel = this._getCommandShortcutLabel(shortcut, defaultLabel);
        if (labelUpdate !== null) {
            var usedNames = this._getUsedSearchShortcutNames(state.profile.shortcuts, index);
            var requestedLabel = typeof labelUpdate === "string" && labelUpdate.trim()
                ? labelUpdate.trim()
                : defaultLabel;
            nextLabel = this._reserveUniqueCommandShortcutName(usedNames, requestedLabel);
        }

        var nextIcon = meta.icon;
        if (Object.prototype.hasOwnProperty.call(updates, "icon")) {
            nextIcon = typeof updates.icon === "string" && updates.icon.trim()
                ? updates.icon.trim()
                : DEFAULT_COMMAND_SHORTCUT_ICON;
        }

        shortcut.type = "search";
        shortcut.name = nextLabel;
        shortcut.query = this._encodeCommandShortcutQuery(meta.commandId);
        shortcut.provider = typeof shortcut.provider === "string" && shortcut.provider.trim()
            ? shortcut.provider.trim()
            : "internal";
        shortcut.nnBridgeCommand = {
            type: "command",
            commandId: meta.commandId,
            icon: nextIcon,
        };
        delete shortcut.alias;
        delete shortcut.commandId;
        delete shortcut.icon;

        await this._saveNNSettings(state.nn);
    }

    async removeCommandShortcut(index) {
        var state = this._getActiveNNProfileState();
        if (!state || !Array.isArray(state.profile.shortcuts)) {
            throw new Error("Notebook Navigator is not available.");
        }
        if (index < 0 || index >= state.profile.shortcuts.length) {
            throw new Error("Command shortcut not found.");
        }
        if (!this._getCommandShortcutMeta(state.profile.shortcuts[index])) {
            throw new Error("Command shortcut not found.");
        }

        state.profile.shortcuts.splice(index, 1);
        await this._saveNNSettings(state.nn);
    }

    async _initializeCommandShortcuts() {
        await this._migrateCommandShortcuts();
        this._queueCommandShortcutRefresh();
    }

    async _migrateCommandShortcuts() {
        var nn = this._getNNPlugin();
        if (!nn || !nn.settings || !Array.isArray(nn.settings.vaultProfiles)) {
            return false;
        }

        var changed = false;

        nn.settings.vaultProfiles.forEach(function (profile) {
            if (!profile || !Array.isArray(profile.shortcuts)) {
                return;
            }

            var profileChanged = false;

            var reservedNames = new Set();
            profile.shortcuts.forEach(function (shortcut) {
                if (!shortcut || shortcut.type !== "search" || this._getCommandShortcutMeta(shortcut) ||
                    typeof shortcut.name !== "string" || !shortcut.name.trim()) {
                    return;
                }
                reservedNames.add(shortcut.name.trim().toLowerCase());
            }, this);

            var nextShortcuts = profile.shortcuts.map(function (shortcut) {
                var meta = this._getCommandShortcutMeta(shortcut);
                if (!meta) {
                    return shortcut;
                }

                var command = this._getCommandById(meta.commandId);
                var fallbackLabel = command && command.name ? command.name : meta.commandId;
                var label = this._reserveUniqueCommandShortcutName(
                    reservedNames,
                    this._getCommandShortcutLabel(shortcut, fallbackLabel)
                );
                var provider = shortcut && typeof shortcut.provider === "string" && shortcut.provider.trim()
                    ? shortcut.provider.trim()
                    : "internal";
                var carrier = this._buildCommandShortcutCarrier(meta.commandId, label, meta.icon, provider);

                if (!this._isSameCommandShortcutCarrier(shortcut, carrier)) {
                    profileChanged = true;
                }

                return carrier;
            }, this);

            if (nextShortcuts.length !== profile.shortcuts.length) {
                profileChanged = true;
            }

            if (profileChanged) {
                profile.shortcuts = nextShortcuts;
                changed = true;
            }
        }, this);

        if (changed) {
            await this._saveNNSettings(nn);
        }

        return changed;
    }

    _installCommandShortcutBridge() {
        if (this._commandShortcutObserver || typeof MutationObserver === "undefined" || !document.body) {
            this._queueCommandShortcutRefresh();
            return;
        }

        var self = this;
        this._commandShortcutObserver = new MutationObserver(function (mutations) {
            for (var i = 0; i < mutations.length; i++) {
                var mutation = mutations[i];
                if (mutation.type === "childList" &&
                    (mutation.addedNodes.length > 0 || mutation.removedNodes.length > 0)) {
                    self._queueCommandShortcutRefresh();
                    return;
                }
            }
        });
        this._commandShortcutObserver.observe(document.body, {
            childList: true,
            subtree: true,
        });
        this._queueCommandShortcutRefresh();
    }

    _teardownCommandShortcutBridge() {
        if (this._commandShortcutObserver) {
            this._commandShortcutObserver.disconnect();
            this._commandShortcutObserver = null;
        }
    }

    _queueCommandShortcutRefresh() {
        if (this._commandShortcutRefreshTimer) {
            window.clearTimeout(this._commandShortcutRefreshTimer);
        }

        this._commandShortcutRefreshTimer = window.setTimeout(() => {
            this._commandShortcutRefreshTimer = null;
            this._refreshCommandShortcutDecorations();
        }, 50);
    }

    _refreshCommandShortcutDecorations() {
        var commandRowsByLabel = new Map();
        this._getCommandShortcutEntries().forEach(function (entry) {
            if (!entry || !entry.label) {
                return;
            }
            commandRowsByLabel.set(entry.label, entry);
        });

        var rows = document.querySelectorAll(".notebook-navigator .nn-shortcut-item[data-nav-item-type='search']");
        rows.forEach(function (row) {
            this._clearCommandShortcutDecoration(row);

            var labelEl = row.querySelector(".nn-shortcut-label");
            var label = labelEl && typeof labelEl.textContent === "string"
                ? labelEl.textContent.trim()
                : "";
            var entry = label ? commandRowsByLabel.get(label) : null;

            if (!entry) {
                return;
            }

            var command = this._getCommandById(entry.commandId);
            var isMissing = !command;
            var iconName = isMissing ? "lucide-alert-triangle" : (entry.icon || DEFAULT_COMMAND_SHORTCUT_ICON);

            row.dataset.nnBridgeCommandId = entry.commandId;
            row.dataset.nnBridgeCommandLabel = entry.label;
            row.dataset.nnBridgeCommandMissing = isMissing ? "true" : "false";
            row.classList.add("nn-bridge-command-shortcut");
            row.classList.toggle("nn-shortcut-item--missing", isMissing);
            row.setAttribute("aria-disabled", isMissing ? "true" : "false");

            var iconEl = row.querySelector(".nn-navitem-icon");
            if (iconEl) {
                this._renderNavItemIcon(iconEl, iconName, "lucide-search");
            }
        }, this);
    }

    _clearCommandShortcutDecoration(row) {
        if (!row || !row.dataset || !row.dataset.nnBridgeCommandId) {
            return;
        }

        delete row.dataset.nnBridgeCommandId;
        delete row.dataset.nnBridgeCommandLabel;
        delete row.dataset.nnBridgeCommandMissing;
        row.classList.remove("nn-bridge-command-shortcut");
        row.classList.remove("nn-shortcut-item--missing");
        row.removeAttribute("aria-disabled");

        var iconEl = row.querySelector(".nn-navitem-icon");
        if (iconEl) {
            this._renderNavItemIcon(iconEl, "lucide-search", "lucide-search");
        }
    }

    _renderNavItemIcon(iconEl, iconName, fallbackIcon) {
        if (!iconEl || !(iconEl instanceof HTMLElement)) {
            return;
        }

        var targetIcon = typeof iconName === "string" && iconName.trim() ? iconName.trim() : fallbackIcon;
        var finalFallback = typeof fallbackIcon === "string" && fallbackIcon.trim()
            ? fallbackIcon.trim()
            : DEFAULT_COMMAND_SHORTCUT_ICON;

        if (iconEl.dataset.nnBridgeRenderedIcon === targetIcon) {
            return;
        }

        while (iconEl.firstChild) {
            iconEl.removeChild(iconEl.firstChild);
        }

        try {
            obsidian.setIcon(iconEl, targetIcon);
            iconEl.dataset.nnBridgeRenderedIcon = targetIcon;
        } catch (_error) {
            while (iconEl.firstChild) {
                iconEl.removeChild(iconEl.firstChild);
            }
            try {
                obsidian.setIcon(iconEl, finalFallback);
                iconEl.dataset.nnBridgeRenderedIcon = finalFallback;
            } catch (_fallbackError) {
                delete iconEl.dataset.nnBridgeRenderedIcon;
            }
        }
    }

    _getCommandShortcutRow(target) {
        if (!target || !(target instanceof Element) || !target.closest) {
            return null;
        }

        var row = target.closest(".notebook-navigator .nn-shortcut-item[data-nav-item-type='search']");
        if (!row || !row.dataset || !row.dataset.nnBridgeCommandId) {
            return null;
        }

        return row;
    }

    _executeCommandShortcut(commandId) {
        if (!commandId || !this.app || !this.app.commands ||
            typeof this.app.commands.executeCommandById !== "function") {
            return false;
        }

        var command = this._getCommandById(commandId);
        if (!command) {
            new obsidian.Notice("Command not found: " + commandId);
            return false;
        }

        this._activateSidebarBridge();

        try {
            return this.app.commands.executeCommandById(commandId) !== false;
        } catch (error) {
            console.error("[NN Bridge] Failed to execute command shortcut:", commandId, error);
            new obsidian.Notice("Unable to run command: " + command.name);
            return false;
        }
    }

    _handleCommandShortcutClick(evt) {
        var target = evt && evt.target;
        var row = this._getCommandShortcutRow(target);
        if (!row) {
            return;
        }
        if (target && target.closest &&
            target.closest(".nn-navitem-hover-action-button, .nn-drag-handle")) {
            return;
        }

        evt.preventDefault();
        evt.stopPropagation();
        if (typeof evt.stopImmediatePropagation === "function") {
            evt.stopImmediatePropagation();
        }

        if (row.dataset.nnBridgeCommandMissing === "true") {
            new obsidian.Notice("Command not found: " + row.dataset.nnBridgeCommandId);
            return;
        }

        this._executeCommandShortcut(row.dataset.nnBridgeCommandId);
    }

    _handleCommandShortcutKeydown(evt) {
        if (!evt || (evt.key !== "Enter" && evt.key !== " ")) {
            return;
        }

        var row = this._getCommandShortcutRow(evt.target);
        if (!row) {
            return;
        }
        if (evt.target && evt.target.closest &&
            evt.target.closest(".nn-navitem-hover-action-button, .nn-drag-handle")) {
            return;
        }

        evt.preventDefault();
        evt.stopPropagation();
        if (typeof evt.stopImmediatePropagation === "function") {
            evt.stopImmediatePropagation();
        }

        if (row.dataset.nnBridgeCommandMissing === "true") {
            new obsidian.Notice("Command not found: " + row.dataset.nnBridgeCommandId);
            return;
        }

        this._executeCommandShortcut(row.dataset.nnBridgeCommandId);
    }

    /**
     * Get shortcut file paths from NN's settings.
     * Shortcuts are stored in vaultProfiles[].shortcuts[].path
     */
    _getShortcutPaths() {
        var nn = this._getNNPlugin();
        if (!nn || !nn.settings) return [];

        var paths = [];
        var profiles = nn.settings.vaultProfiles;
        if (Array.isArray(profiles)) {
            profiles.forEach(function (profile) {
                if (!Array.isArray(profile.shortcuts)) return;
                profile.shortcuts.forEach(function (s) {
                    if (s && s.path) paths.push(s.path);
                });
            });
        }
        // Also check top-level shortcuts array (older format)
        if (Array.isArray(nn.settings.shortcuts)) {
            nn.settings.shortcuts.forEach(function (s) {
                if (s && s.path) paths.push(s.path);
            });
        }
        return paths;
    }

    // ── Exclusion List ─────────────────────────────────────────────

    _rebuildExclusionList() {
        if (!this.settings.recentsExclusionEnabled || !this.settings.recentsExclusionList) {
            this._excludedNames = [];
            return;
        }
        this._excludedNames = this.settings.recentsExclusionList
            .split("\n")
            .map(function (line) { return line.trim().toLowerCase(); })
            .filter(function (line) { return line.length > 0; });
    }

    /**
     * Check if a file path should be excluded from recents.
     * @param {string} filePath - full vault-relative path like "folder/note.md"
     * @returns {boolean}
     */
    _shouldExclude(filePath) {
        if (!filePath) return false;

        // Auto-exclude: shortcut paths
        if (this.settings.hideShortcutsFromRecents) {
            var shortcutPaths = this._getShortcutPaths();
            for (var i = 0; i < shortcutPaths.length; i++) {
                if (filePath === shortcutPaths[i]) return true;
            }
        }

        // Manual exclusion by name
        if (this._excludedNames.length > 0) {
            // Extract basename without extension for matching
            var basename = filePath.split("/").pop() || "";
            basename = basename.replace(/\.[^.]+$/, "").toLowerCase();
            var fullLower = filePath.toLowerCase();

            for (var j = 0; j < this._excludedNames.length; j++) {
                var ex = this._excludedNames[j];
                if (basename === ex || basename.indexOf(ex) !== -1 || fullLower.indexOf(ex) !== -1) {
                    return true;
                }
            }
        }

        return false;
    }

    // ── Monkey-patch NN's recentNotesService ────────────────────────

    _applyPatch() {
        var nn = this._getNNPlugin();
        if (!nn) {
            // NN not loaded yet — retry
            var self = this;
            var retryCount = 0;
            var retryInterval = setInterval(function () {
                retryCount++;
                var nnRetry = self._getNNPlugin();
                if (nnRetry) {
                    clearInterval(retryInterval);
                    self._doPatch(nnRetry);
                } else if (retryCount > 20) {
                    clearInterval(retryInterval);
                }
            }, 500);
            this.register(function () { clearInterval(retryInterval); });
            return;
        }
        this._doPatch(nn);
    }

    _doPatch(nn) {
        if (this._patchApplied) return;
        if (!nn.recentNotesService) {
            // Service not yet initialized — wait
            var self = this;
            var retryCount = 0;
            var retryInterval = setInterval(function () {
                retryCount++;
                if (nn.recentNotesService) {
                    clearInterval(retryInterval);
                    self._patchService(nn);
                } else if (retryCount > 20) {
                    clearInterval(retryInterval);
                }
            }, 500);
            this.register(function () { clearInterval(retryInterval); });
            return;
        }
        this._patchService(nn);
    }

    _patchService(nn) {
        var svc = nn.recentNotesService;
        var self = this;

        // Save original method
        this._originalRecordFileOpen = svc.recordFileOpen.bind(svc);

        // Replace with filtered version
        svc.recordFileOpen = function patchedRecordFileOpen(file) {
            if (self._isExclusionActive() && file && file.path && self._shouldExclude(file.path)) {
                // Don't add this file to recents at all
                return false;
            }
            return self._originalRecordFileOpen(file);
        };

        this._patchApplied = true;
        this._patchedService = svc;
    }

    _removePatch() {
        if (this._patchApplied && this._patchedService && this._originalRecordFileOpen) {
            this._patchedService.recordFileOpen = this._originalRecordFileOpen;
            this._originalRecordFileOpen = null;
            this._patchApplied = false;
            this._patchedService = null;
        }
    }

    _isExclusionActive() {
        return this.settings.hideShortcutsFromRecents ||
               (this.settings.recentsExclusionEnabled && this._excludedNames.length > 0);
    }

    /**
     * Remove currently-excluded files from the existing recents list.
     * This handles files that were added before the exclusion was enabled.
     */
    _cleanExistingRecents() {
        if (!this._isExclusionActive()) return;

        var nn = this._getNNPlugin();
        if (!nn || typeof nn.getRecentNotes !== "function") return;

        var recents = nn.getRecentNotes();
        if (!recents || recents.length === 0) return;

        var self = this;
        var filtered = recents.filter(function (path) {
            return !self._shouldExclude(path);
        });

        if (filtered.length !== recents.length) {
            nn.setRecentNotes(filtered);
        }
    }

    /** Called when exclusion settings change */
    refreshExclusions() {
        this._rebuildExclusionList();
        // Clean existing recents with new settings
        this._cleanExistingRecents();
        // Make sure patch is applied
        if (!this._patchApplied) {
            this._applyPatch();
        }
    }

    // ── Sidebar embed ──────────────────────────────────────────────

    _isSidebarEmbedActive() {
        return !!(
            this.settings.sidebarEmbedEnabled &&
            this.settings.sidebarEmbedMarkdown &&
            this.settings.sidebarEmbedMarkdown.trim().length > 0
        );
    }

    _destroyMarkdownComponents() {
        if (!Array.isArray(this._activeMarkdownComponents)) return;
        this._activeMarkdownComponents.forEach(function (component) {
            if (component && typeof component.unload === "function") {
                component.unload();
            }
        });
        this._activeMarkdownComponents = [];
    }

    _removeSidebarEmbeds() {
        this._destroyMarkdownComponents();
        var embeds = document.querySelectorAll(".nn-bridge-sidebar-embed");
        embeds.forEach(function (el) { el.remove(); });
    }

    refreshSidebarEmbed() {
        var self = this;
        if (this._refreshDebounceTimer) {
            window.clearTimeout(this._refreshDebounceTimer);
        }
        return new Promise(function (resolve) {
            self._refreshDebounceTimer = window.setTimeout(function () {
                self._refreshDebounceTimer = null;
                self._runRefreshSidebarEmbed().then(resolve, resolve);
            }, 200);
        });
    }

    async _runRefreshSidebarEmbed() {
        if (this._refreshInFlight) {
            this._refreshQueued = true;
            return;
        }
        this._refreshInFlight = true;
        try {
            await this._doRefreshSidebarEmbed();
        } finally {
            this._refreshInFlight = false;
            if (this._refreshQueued) {
                this._refreshQueued = false;
                var self = this;
                window.setTimeout(function () { self._runRefreshSidebarEmbed(); }, 0);
            }
        }
    }

    async _doRefreshSidebarEmbed() {
        if (!this._isSidebarEmbedActive()) {
            if (this._lastRenderFingerprint !== "") {
                this._removeSidebarEmbeds();
                this._lastRenderFingerprint = "";
            }
            return;
        }

        var containers = document.querySelectorAll(".notebook-navigator");
        var self = this;
        if (containers.length === 0) {
            var retryTimer = window.setTimeout(function () {
                self.refreshSidebarEmbed();
            }, 500);
            this.register(function () { window.clearTimeout(retryTimer); });
            return;
        }

        var markdown = this.settings.sidebarEmbedMarkdown || "";
        var sourcePath = this.app.workspace.getActiveFile()
            ? this.app.workspace.getActiveFile().path
            : "/";

        var existingEmbeds = document.querySelectorAll(".nn-bridge-sidebar-embed");
        var fingerprint = [
            markdown,
            this.settings.sidebarEmbedTitle || "",
            this.settings.sidebarEmbedPosition || "",
            String(this.settings.sidebarEmbedTopSpacing || 0),
            this.settings.sidebarEmbedAfterSelector || "",
            String(containers.length),
        ].join(" ");

        if (
            fingerprint === this._lastRenderFingerprint &&
            existingEmbeds.length === containers.length
        ) {
            return;
        }

        this._removeSidebarEmbeds();

        for (var i = 0; i < containers.length; i++) {
            await this._renderSidebarEmbedForContainer(containers[i], markdown, sourcePath);
        }

        this._lastRenderFingerprint = fingerprint;
    }

    _resolveSidebarEmbedMount(container) {
        var pane = container.querySelector(".nn-navigation-pane");
        if (!pane) return null;

        var customSelector = (this.settings.sidebarEmbedAfterSelector || "").trim();
        if (customSelector) {
            try {
                var marker = pane.querySelector(customSelector);
                if (marker && marker.parentElement) {
                    return { parent: marker.parentElement, afterElement: marker };
                }
            } catch (_err) {
                // Ignore invalid selectors and use default placement.
            }
        }

        var scroller = pane.querySelector(".nn-navigation-pane-scroller");
        if (scroller) {
            return { parent: scroller, afterElement: null };
        }

        return { parent: pane, afterElement: null };
    }

    async _renderSidebarEmbedForContainer(container, markdown, sourcePath) {
        var mount = this._resolveSidebarEmbedMount(container);
        if (!mount || !mount.parent) return;

        var host = document.createElement("div");
        host.className = "nn-bridge-sidebar-embed";
        host.dataset.position = this.settings.sidebarEmbedPosition === "top" ? "top" : "bottom";
        host.style.setProperty("--nn-bridge-sidebar-embed-top-spacing", String(this.settings.sidebarEmbedTopSpacing || 0) + "px");

        if (this.settings.sidebarEmbedTitle && this.settings.sidebarEmbedTitle.trim()) {
            var title = document.createElement("div");
            title.className = "nn-bridge-sidebar-embed-title";
            title.textContent = this.settings.sidebarEmbedTitle.trim();
            host.appendChild(title);
        }

        var markdownHost = document.createElement("div");
        markdownHost.className = "nn-bridge-sidebar-embed-content";
        host.appendChild(markdownHost);

        var position = this.settings.sidebarEmbedPosition === "top" ? "top" : "bottom";
        if (mount.afterElement) {
            mount.afterElement.insertAdjacentElement(position === "top" ? "beforebegin" : "afterend", host);
        } else if (position === "top" && mount.parent.firstChild) {
            mount.parent.insertBefore(host, mount.parent.firstChild);
        } else {
            mount.parent.appendChild(host);
        }

        var childComponent = new obsidian.Component();
        childComponent.load();
        this._activeMarkdownComponents.push(childComponent);
        await obsidian.MarkdownRenderer.render(
            this.app,
            markdown,
            markdownHost,
            sourcePath,
            childComponent
        );
    }

    _isMarkdownLeaf(leaf) {
        return !!(leaf && leaf.view && typeof leaf.view.getViewType === "function" &&
            leaf.view.getViewType() === "markdown");
    }

    _getBridgeEditor() {
        var leaf = this._getBridgeLeaf();
        var view = leaf && leaf.view;
        if (!view) {
            return null;
        }

        var editor = view.editor || null;
        if (!editor && typeof view.getMode === "function" && view.editor) {
            editor = view.editor;
        }
        if (!editor) {
            return null;
        }

        return {
            editor: editor,
            file: view.file || null,
        };
    }

    _readWorkspacePropertyRaw(propName) {
        var ws = this.app.workspace;
        if (!ws) {
            return undefined;
        }

        var entry = null;
        if (Array.isArray(this._workspaceBridgeShadowedProps)) {
            for (var i = 0; i < this._workspaceBridgeShadowedProps.length; i++) {
                if (this._workspaceBridgeShadowedProps[i] &&
                    this._workspaceBridgeShadowedProps[i].propName === propName) {
                    entry = this._workspaceBridgeShadowedProps[i];
                    break;
                }
            }
        }

        if (entry && typeof entry.getRawValue === "function") {
            return entry.getRawValue();
        }

        if (entry && entry.originalDescriptor && typeof entry.originalDescriptor.get === "function") {
            return entry.originalDescriptor.get.call(ws);
        }

        var prototype = Object.getPrototypeOf(ws);
        var prototypeDescriptor = prototype
            ? Object.getOwnPropertyDescriptor(prototype, propName)
            : null;
        if (prototypeDescriptor && typeof prototypeDescriptor.get === "function") {
            return prototypeDescriptor.get.call(ws);
        }

        return ws[propName];
    }

    _handleSidebarEmbedInteraction(evt) {
        var target = evt && evt.target;
        if (!target || !(target instanceof Element)) return;
        if (!target.closest || !target.closest(".nn-bridge-sidebar-embed")) return;
        if (!this._getBridgeLeaf()) return;
        this._activateSidebarBridge();
    }

    _getBridgeLeaf() {
        if (this._isMarkdownLeaf(this._lastMarkdownLeaf)) return this._lastMarkdownLeaf;
        var leaf = this._findMarkdownLeafForCommands();
        if (this._isMarkdownLeaf(leaf)) {
            this._lastMarkdownLeaf = leaf;
            return leaf;
        }
        return null;
    }

    _activateSidebarBridge() {
        this._sidebarBridgeActive = true;
        if (this._sidebarBridgeTimer) window.clearTimeout(this._sidebarBridgeTimer);
        var self = this;
        // Active long enough to cover Buttons -> executeCommandById -> Templater
        // async work (which may prompt the user). Auto-clears after.
        this._sidebarBridgeTimer = window.setTimeout(function () {
            self._sidebarBridgeActive = false;
            self._sidebarBridgeTimer = null;
        }, 30000);
    }

    _installWorkspaceBridge() {
        if (this._workspaceBridgeInstalled) return;
        var ws = this.app.workspace;
        if (!ws) return;
        var self = this;

        if (typeof ws.getActiveViewOfType === "function") {
            this._origGetActiveViewOfType = ws.getActiveViewOfType;
            ws.getActiveViewOfType = function (type) {
                if (self._sidebarBridgeActive) {
                    var leaf = self._getBridgeLeaf();
                    if (leaf && leaf.view && type && leaf.view instanceof type) {
                        return leaf.view;
                    }
                }
                return self._origGetActiveViewOfType.call(ws, type);
            };
        }

        if (typeof ws.getMostRecentLeaf === "function") {
            this._origGetMostRecentLeaf = ws.getMostRecentLeaf;
            ws.getMostRecentLeaf = function () {
                if (self._sidebarBridgeActive) {
                    var leaf = self._getBridgeLeaf();
                    if (leaf) {
                        return leaf;
                    }
                }
                return self._origGetMostRecentLeaf.apply(ws, arguments);
            };
        }

        if (typeof ws.getActiveFile === "function") {
            this._origGetActiveFile = ws.getActiveFile;
            ws.getActiveFile = function () {
                if (self._sidebarBridgeActive) {
                    var leaf = self._getBridgeLeaf();
                    if (leaf && leaf.view && leaf.view.file) {
                        return leaf.view.file;
                    }
                }
                return self._origGetActiveFile.call(ws);
            };
        }

        this._shadowWorkspaceGetter("activeLeaf", function () {
            return self._getBridgeLeaf();
        });
        this._shadowWorkspaceGetter("lastActiveLeaf", function () {
            return self._getBridgeLeaf();
        });
        this._shadowWorkspaceGetter("activeEditor", function () {
            return self._getBridgeEditor();
        });

        this._workspaceBridgeInstalled = true;
    }

    _shadowWorkspaceGetter(propName, bridgeResolver) {
        var ws = this.app.workspace;
        if (!ws) return;

        var self = this;
        var hadOwnProperty = Object.prototype.hasOwnProperty.call(ws, propName);
        var originalDescriptor = hadOwnProperty
            ? Object.getOwnPropertyDescriptor(ws, propName)
            : null;
        var prototype = Object.getPrototypeOf(ws);
        var prototypeDescriptor = prototype
            ? Object.getOwnPropertyDescriptor(prototype, propName)
            : null;
        var getter = null;
        var setter = null;
        var enumerable = false;
        var hasStoredValue = false;
        var storedValue;

        if (originalDescriptor) {
            getter = typeof originalDescriptor.get === "function" ? originalDescriptor.get : null;
            setter = typeof originalDescriptor.set === "function" ? originalDescriptor.set : null;
            enumerable = !!originalDescriptor.enumerable;
            if (Object.prototype.hasOwnProperty.call(originalDescriptor, "value")) {
                hasStoredValue = true;
                storedValue = originalDescriptor.value;
            }
        } else if (prototypeDescriptor) {
            getter = typeof prototypeDescriptor.get === "function" ? prototypeDescriptor.get : null;
            setter = typeof prototypeDescriptor.set === "function" ? prototypeDescriptor.set : null;
            enumerable = !!prototypeDescriptor.enumerable;
        }

        if (!getter && !setter && !hasStoredValue) {
            try {
                storedValue = ws[propName];
                hasStoredValue = true;
            } catch (_error) {
                storedValue = undefined;
                hasStoredValue = false;
            }
        }

        var getRawValue = function () {
            if (!setter && hasStoredValue) {
                return storedValue;
            }
            if (getter) {
                return getter.call(ws);
            }
            return storedValue;
        };

        Object.defineProperty(ws, propName, {
            configurable: true,
            enumerable: enumerable,
            get: function () {
                if (self._sidebarBridgeActive) {
                    var bridged = bridgeResolver();
                    if (bridged != null) {
                        return bridged;
                    }
                }
                return getRawValue();
            },
            set: function (value) {
                if (setter) {
                    return setter.call(ws, value);
                }
                storedValue = value;
                hasStoredValue = true;
                return value;
            },
        });

        this._workspaceBridgeShadowedProps.push({
            propName: propName,
            hadOwnProperty: hadOwnProperty,
            originalDescriptor: originalDescriptor,
            getRawValue: getRawValue,
        });
    }

    _uninstallWorkspaceBridge() {
        if (!this._workspaceBridgeInstalled) return;
        var ws = this.app.workspace;
        if (ws) {
            if (this._origGetActiveViewOfType) {
                ws.getActiveViewOfType = this._origGetActiveViewOfType;
            }
            if (this._origGetActiveFile) {
                ws.getActiveFile = this._origGetActiveFile;
            }
            if (this._origGetMostRecentLeaf) {
                ws.getMostRecentLeaf = this._origGetMostRecentLeaf;
            }
            if (Array.isArray(this._workspaceBridgeShadowedProps)) {
                this._workspaceBridgeShadowedProps.forEach(function (entry) {
                    if (!entry || !entry.propName) return;
                    if (entry.hadOwnProperty && entry.originalDescriptor) {
                        Object.defineProperty(ws, entry.propName, entry.originalDescriptor);
                    } else {
                        delete ws[entry.propName];
                    }
                });
            }
        }
        this._origGetActiveViewOfType = null;
        this._origGetActiveFile = null;
        this._origGetMostRecentLeaf = null;
        this._workspaceBridgeShadowedProps = [];
        this._workspaceBridgeInstalled = false;
    }

    _findMarkdownLeafForCommands() {
        var workspace = this.app.workspace;
        if (!workspace) return null;

        var activeLeaf = this._readWorkspacePropertyRaw("activeLeaf");
        if (this._isMarkdownLeaf(activeLeaf)) {
            return activeLeaf;
        }

        if (this._origGetMostRecentLeaf || typeof workspace.getMostRecentLeaf === "function") {
            var recentGetter = this._origGetMostRecentLeaf || workspace.getMostRecentLeaf;
            var recent = recentGetter.call(workspace);
            if (this._isMarkdownLeaf(recent)) return recent;
        }

        var markdownLeaves = [];
        if (typeof workspace.getLeavesOfType === "function") {
            markdownLeaves = workspace.getLeavesOfType("markdown") || [];
        }
        if (markdownLeaves.length === 0) return null;

        var activeFile = this._origGetActiveFile
            ? this._origGetActiveFile.call(workspace)
            : (typeof workspace.getActiveFile === "function" ? workspace.getActiveFile() : null);
        if (activeFile && activeFile.path) {
            for (var j = 0; j < markdownLeaves.length; j++) {
                var candidate = markdownLeaves[j];
                if (candidate && candidate.view && candidate.view.file &&
                    candidate.view.file.path === activeFile.path) {
                    return candidate;
                }
            }
        }

        for (var i = 0; i < markdownLeaves.length; i++) {
            var leaf = markdownLeaves[i];
            var root = typeof leaf.getRoot === "function" ? leaf.getRoot() : null;
            var rootType = root && typeof root.type === "string" ? root.type : "";
            if (rootType === "" || rootType === "split" || rootType === "floating") {
                return leaf;
            }
        }
        return markdownLeaves[0];
    }
    // ── Sidebar Tabs Bridge ──────────────────────────────────────────

    _installSidebarTabBridge() {
        if (this._sidebarTabObserver) return;
        var self = this;
        this._sidebarTabObserver = new MutationObserver(function (mutations) {
            self._refreshSidebarTabs();
        });
        
        var leftSplit = document.querySelector(".workspace-split.mod-left-split");
        if (leftSplit) {
            this._sidebarTabObserver.observe(leftSplit, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ["data-type", "class"]
            });
        }
        
        this._refreshSidebarTabs();
        
        this._sidebarTabRefreshInterval = window.setInterval(function() {
            self._refreshSidebarTabs();
        }, 2000);
    }

    _teardownSidebarTabBridge() {
        if (this._sidebarTabObserver) {
            this._sidebarTabObserver.disconnect();
            this._sidebarTabObserver = null;
        }
        if (this._sidebarTabRefreshInterval) {
            window.clearInterval(this._sidebarTabRefreshInterval);
            this._sidebarTabRefreshInterval = null;
        }
        var injected = document.querySelectorAll(".nn-bridge-sidebar-command");
        injected.forEach(function(el) { el.remove(); });
    }

    _refreshSidebarTabs() {
        if (!this.settings.sidebarTabIconsEnabled && !this.settings.sidebarTabCommandsEnabled) {
            var injected = document.querySelectorAll(".nn-bridge-sidebar-command");
            injected.forEach(function(el) { el.remove(); });
            return;
        }

        var headerContainer = document.querySelector(".mod-left-split .workspace-tab-header-container");
        if (!headerContainer) {
            // Fallback for some themes or older/newer layouts
            headerContainer = document.querySelector(".workspace-split.mod-left-split .workspace-tab-header-container");
        }
        if (!headerContainer) return;
        
        var innerContainer = headerContainer.querySelector(".workspace-tab-header-container-inner");
        if (!innerContainer) return;

        // 1. Swap icons based on config
        if (this.settings.sidebarTabIconsEnabled) {
            var lines = this.settings.sidebarTabIcons.split("\n");
            var iconMap = {};
            lines.forEach(function(line) {
                var parts = line.split(":");
                if (parts.length >= 2) {
                    iconMap[parts[0].trim()] = parts[1].trim();
                }
            });

            var tabs = innerContainer.querySelectorAll(".workspace-tab-header");
            tabs.forEach(function(tab) {
                var type = tab.getAttribute("data-type");
                if (type && iconMap[type]) {
                    if (!tab.dataset.nnCustomIcon || tab.dataset.nnCustomIcon !== iconMap[type]) {
                        var iconEl = tab.querySelector(".workspace-tab-header-inner-icon");
                        if (iconEl) {
                            iconEl.empty();
                            obsidian.setIcon(iconEl, iconMap[type]);
                            tab.dataset.nnCustomIcon = iconMap[type];
                        }
                    }
                }
            });
        }

        // 2. Inject commands
        if (this.settings.sidebarTabCommandsEnabled) {
            var cmdLines = this.settings.sidebarTabCommands.split("\n");
            var expectedCmds = [];
            cmdLines.forEach(function(line) {
                var parts = line.split(":");
                if (parts.length >= 3) {
                    var label = parts[0].trim();
                    var icon = parts[1].trim();
                    var cmdId = parts.slice(2).join(":").trim();
                    expectedCmds.push({ label: label, icon: icon, cmdId: cmdId });
                }
            });

            var existing = Array.from(innerContainer.querySelectorAll(".nn-bridge-sidebar-command"));
            
            if (existing.length > expectedCmds.length) {
                for (var i = expectedCmds.length; i < existing.length; i++) {
                    existing[i].remove();
                }
            }

            var self = this;
            expectedCmds.forEach(function(cmd, i) {
                var el = existing[i];
                if (!el) {
                    el = document.createElement("div");
                    // We also add data-type so it gets styled properly or tracked
                    el.className = "workspace-tab-header nn-bridge-sidebar-command clickable-icon";
                    el.dataset.type = "nn-bridge-command";
                    innerContainer.appendChild(el);
                    
                    var iconDiv = document.createElement("div");
                    iconDiv.className = "workspace-tab-header-inner-icon";
                    el.appendChild(iconDiv);
                    
                    el.addEventListener("click", function() {
                        self.app.commands.executeCommandById(el.dataset.cmdId);
                    });
                }
                
                if (el.dataset.cmdId !== cmd.cmdId || el.dataset.nnCustomIcon !== cmd.icon) {
                    el.dataset.cmdId = cmd.cmdId;
                    el.dataset.nnCustomIcon = cmd.icon;
                    el.setAttribute("aria-label", cmd.label);
                    var iconEl = el.querySelector(".workspace-tab-header-inner-icon");
                    if (iconEl) {
                        iconEl.empty();
                        obsidian.setIcon(iconEl, cmd.icon);
                    }
                }
            });
        } else {
            var existing = innerContainer.querySelectorAll(".nn-bridge-sidebar-command");
            existing.forEach(function(el) { el.remove(); });
        }
    }

    refreshCustomSections() {
        this._customSectionsRetryCount = 0;
        var self = this;
        if (this._customSectionsRefreshTimer) {
            window.clearTimeout(this._customSectionsRefreshTimer);
        }
        this._customSectionsRefreshTimer = window.setTimeout(function () {
            self._customSectionsRefreshTimer = null;
            self._renderCustomSections();
        }, 150);
    }

    _removeCustomSections() {
        var elements = document.querySelectorAll(".nn-bridge-custom-sections-container");
        elements.forEach(function (el) { el.remove(); });
    }

    _renderCustomSections() {
        this._removeCustomSections();

        var sections = this.settings.customSections;
        if (!Array.isArray(sections) || sections.length === 0) {
            return;
        }

        var containers = document.querySelectorAll(".notebook-navigator");
        if (containers.length === 0) {
            // NN container not mounted yet — retry
            this._retryCustomSectionsRender();
            return;
        }

        var self = this;
        var injectedCount = 0;

        containers.forEach(function (container) {
            // Try multiple strategies to find the injection point
            var pane = container.querySelector(".nn-navigation-pane");
            if (!pane) {
                return;
            }

            // Find the best injection parent and anchor.
            // Structure: .nn-navigation-pane > .nn-navigation-pane-chrome + .nn-navigation-pane-panel
            //   .nn-navigation-pane-panel > .nn-shortcut-pinned? + .nn-navigation-pane-scroller
            // We want to insert AFTER shortcuts (if present) and BEFORE the scroller.
            var panel = pane.querySelector(".nn-navigation-pane-panel");
            var scroller = pane.querySelector(".nn-navigation-pane-scroller");
            var shortcuts = pane.querySelector(".nn-shortcut-pinned");

            // Determine the parent container and insert-before reference
            var insertParent = null;
            var insertBefore = null;
            
            var position = self.settings.customSectionsPosition || "below-shortcuts";

            if (position === "custom" && self.settings.customSectionsSelector) {
                var targetEl = pane.querySelector(self.settings.customSectionsSelector) || container.querySelector(self.settings.customSectionsSelector);
                if (targetEl && targetEl.parentElement) {
                    insertParent = targetEl.parentElement;
                    insertBefore = targetEl.nextSibling;
                }
            }

            if (!insertParent) {
                if (position === "top") {
                    insertParent = panel || pane;
                    insertBefore = insertParent.firstChild;
                } else if (position === "bottom") {
                    insertParent = pane; // Bottom of the whole pane
                    insertBefore = null;
                } else {
                    // Default: below shortcuts or before scroller
                    if (panel && scroller) {
                        insertParent = panel;
                        insertBefore = scroller;
                    } else if (shortcuts && shortcuts.parentElement) {
                        insertParent = shortcuts.parentElement;
                        insertBefore = shortcuts.nextSibling;
                    } else if (scroller && scroller.parentElement) {
                        insertParent = scroller.parentElement;
                        insertBefore = scroller;
                    } else if (panel) {
                        insertParent = panel;
                        insertBefore = null;
                    } else {
                        insertParent = pane;
                        insertBefore = null;
                    }
                }
            }

            if (!insertParent) return;

            // Create wrapper
            var wrapper = document.createElement("div");
            wrapper.className = "nn-bridge-custom-sections-container";

            // Inject sections
            sections.forEach(function (section) {
                // Render section header
                var headerRow = null;

                if (!section.hideHeader) {
                    headerRow = document.createElement("div");
                    headerRow.className = "nn-navitem nn-shortcut-header-item nn-bridge-section-header clickable";
                    headerRow.dataset.sectionId = section.id;
                    headerRow.setAttribute("tabindex", "0");

                    var contentDiv = document.createElement("div");
                    contentDiv.className = "nn-navitem-content";

                    // Collapse chevron if collapsible
                    if (section.collapsible !== false) {
                        var chevronDiv = document.createElement("div");
                        chevronDiv.className = "nn-navitem-chevron nn-navitem-chevron--has-children nn-bridge-collapse-chevron";
                        if (section.collapsed) {
                            chevronDiv.classList.add("is-collapsed");
                        }
                        
                        chevronDiv.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-chevron-down"><path d="m6 9 6 6 6-6"/></svg>';
                        contentDiv.appendChild(chevronDiv);
                    } else {
                        var placeholder = document.createElement("div");
                        placeholder.className = "nn-navitem-chevron nn-navitem-chevron--no-children";
                        contentDiv.appendChild(placeholder);
                    }

                    // Section Icon
                    var iconDiv = document.createElement("div");
                    iconDiv.className = "nn-navitem-icon";
                    try {
                        obsidian.setIcon(iconDiv, section.icon || "folder");
                    } catch (e) {
                        obsidian.setIcon(iconDiv, "folder");
                    }
                    contentDiv.appendChild(iconDiv);

                    // Section Title
                    var titleDiv = document.createElement("div");
                    titleDiv.className = "nn-navitem-name";
                    titleDiv.textContent = section.title || "Untitled";
                    contentDiv.appendChild(titleDiv);

                    headerRow.appendChild(contentDiv);
                    wrapper.appendChild(headerRow);
                }

                // Render items if not collapsed
                if (!section.collapsed || section.collapsible === false || section.hideHeader) {
                    var itemsContainer = document.createElement("div");
                    itemsContainer.className = "nn-bridge-section-items";

                    if (Array.isArray(section.items)) {
                        section.items.forEach(function (item) {
                            var itemRow = document.createElement("div");
                            itemRow.className = "nn-navitem nn-shortcut-item nn-bridge-custom-item clickable";
                            itemRow.dataset.type = item.type;
                            itemRow.dataset.itemId = item.id;
                            itemRow.setAttribute("tabindex", "0");
                            
                            var isMissing = false;
                            if (item.type === "note") {
                                var fileExists = self.app.vault.getAbstractFileByPath(item.pathOrId) != null;
                                if (!fileExists) {
                                    isMissing = true;
                                    itemRow.classList.add("nn-shortcut-item--missing");
                                }
                                itemRow.dataset.path = item.pathOrId;
                            } else if (item.type === "command") {
                                var commandExists = self._getCommandById(item.pathOrId) != null;
                                if (!commandExists) {
                                    isMissing = true;
                                    itemRow.classList.add("nn-shortcut-item--missing");
                                }
                                itemRow.dataset.commandId = item.pathOrId;
                            }

                            var itemContent = document.createElement("div");
                            itemContent.className = "nn-navitem-content";
                            itemContent.style.paddingInlineStart = "28px";

                            var itemIconDiv = document.createElement("div");
                            itemIconDiv.className = "nn-navitem-icon";
                            
                            var resolvedIcon = item.icon;
                            if (!resolvedIcon) {
                                resolvedIcon = (item.type === "note" ? "file-text" : "terminal");
                            }
                            if (isMissing) {
                                resolvedIcon = "alert-triangle";
                            }

                            try {
                                obsidian.setIcon(itemIconDiv, resolvedIcon);
                            } catch (e) {
                                obsidian.setIcon(itemIconDiv, item.type === "note" ? "file-text" : "terminal");
                            }
                            itemContent.appendChild(itemIconDiv);

                            var itemLabelDiv = document.createElement("div");
                            itemLabelDiv.className = "nn-shortcut-label";
                            itemLabelDiv.textContent = item.name || item.pathOrId || "Untitled";
                            itemContent.appendChild(itemLabelDiv);

                            itemRow.appendChild(itemContent);
                            itemsContainer.appendChild(itemRow);
                        });
                    }
                    wrapper.appendChild(itemsContainer);
                }
            });

            if (insertBefore) {
                insertParent.insertBefore(wrapper, insertBefore);
            } else {
                insertParent.appendChild(wrapper);
            }
            injectedCount++;
        });

        // If we found containers but couldn't inject into any of them,
        // the NN internal DOM may not be ready — retry
        if (injectedCount === 0) {
            this._retryCustomSectionsRender();
        }
    }

    _retryCustomSectionsRender() {
        if (this._customSectionsRetryCount === undefined) {
            this._customSectionsRetryCount = 0;
        }
        // Retry up to 15 times with exponential backoff (150ms, 300ms, 450ms... up to ~10s total)
        if (this._customSectionsRetryCount >= 15) {
            console.warn("[NN Bridge] Custom sections: gave up waiting for NN DOM after 15 retries.");
            this._customSectionsRetryCount = 0;
            return;
        }
        this._customSectionsRetryCount++;
        var delay = Math.min(this._customSectionsRetryCount * 300, 2000);
        var self = this;
        var retryTimer = window.setTimeout(function () {
            self._renderCustomSections();
        }, delay);
        this.register(function () { window.clearTimeout(retryTimer); });
    }

    _handleCustomSectionClick(evt) {
        var target = evt && evt.target;
        if (!target || !(target instanceof Element) || !target.closest) {
            return;
        }

        var header = target.closest(".nn-bridge-section-header");
        if (header) {
            evt.preventDefault();
            evt.stopPropagation();
            var sectionId = header.dataset.sectionId;
            if (sectionId) {
                var section = this.settings.customSections.find(s => s.id === sectionId);
                if (section && section.collapsible !== false) {
                    section.collapsed = !section.collapsed;
                    this.saveSettings();
                    this.refreshCustomSections();
                }
            }
            return;
        }

        var item = target.closest(".nn-bridge-custom-item");
        if (item) {
            evt.preventDefault();
            evt.stopPropagation();
            this._executeCustomItem(item);
        }
    }

    _handleCustomSectionKeydown(evt) {
        if (!evt || (evt.key !== "Enter" && evt.key !== " ")) {
            return;
        }
        var target = evt && evt.target;
        if (!target || !(target instanceof Element) || !target.closest) {
            return;
        }

        var header = target.closest(".nn-bridge-section-header");
        if (header) {
            evt.preventDefault();
            evt.stopPropagation();
            var sectionId = header.dataset.sectionId;
            if (sectionId) {
                var section = this.settings.customSections.find(s => s.id === sectionId);
                if (section && section.collapsible !== false) {
                    section.collapsed = !section.collapsed;
                    this.saveSettings();
                    this.refreshCustomSections();
                }
            }
            return;
        }

        var item = target.closest(".nn-bridge-custom-item");
        if (item) {
            evt.preventDefault();
            evt.stopPropagation();
            this._executeCustomItem(item);
        }
    }

    _executeCustomItem(itemEl) {
        var type = itemEl.dataset.type;
        if (type === "note") {
            var path = itemEl.dataset.path;
            if (path) {
                var file = this.app.vault.getAbstractFileByPath(path);
                if (file) {
                    try {
                        this.app.workspace.getLeaf(false).openFile(file);
                    } catch (e) {
                        this.app.workspace.openLinkText(path, "", false);
                    }
                } else {
                    new obsidian.Notice("File not found: " + path);
                }
            }
        } else if (type === "command") {
            var commandId = itemEl.dataset.commandId;
            if (commandId) {
                this._executeCommandShortcut(commandId);
            }
        }
    }

    _handleFileRename(oldPath, newPath) {
        if (!Array.isArray(this.settings.customSections)) return;
        var changed = false;
        this.settings.customSections.forEach(function (section) {
            if (Array.isArray(section.items)) {
                section.items.forEach(function (item) {
                    if (item.type === "note" && item.pathOrId === oldPath) {
                        item.pathOrId = newPath;
                        var oldBasename = oldPath.split("/").pop().replace(/\.[^.]+$/, "");
                        if (item.name === oldBasename) {
                            item.name = newPath.split("/").pop().replace(/\.[^.]+$/, "");
                        }
                        changed = true;
                    }
                });
            }
        });
        if (changed) {
            this.saveSettings();
            this.refreshCustomSections();
        }
    }

    _handleFileDelete(filePath) {
        if (!Array.isArray(this.settings.customSections)) return;
        var changed = false;
        this.settings.customSections.forEach(function (section) {
            if (Array.isArray(section.items)) {
                section.items.forEach(function (item) {
                    if (item.type === "note" && item.pathOrId === filePath) {
                        changed = true;
                    }
                });
            }
        });
        if (changed) {
            this.refreshCustomSections();
        }
    }
}

class CommandShortcutSuggestModal extends obsidian.FuzzySuggestModal {
    constructor(app, plugin, onChoose) {
        super(app);
        this.plugin = plugin;
        this.onChoose = onChoose;
        this.commands = plugin._getCommandRegistry().filter(function (command) {
            return !plugin._hasCommandShortcut(command.id);
        });
        this.setPlaceholder("Search commands to pin into Notebook Navigator shortcuts");
    }

    getItems() {
        return this.commands;
    }

    getItemText(command) {
        return command.name + " " + command.id;
    }

    renderSuggestion(match, el) {
        var command = match && match.item ? match.item : match;
        if (!command) {
            return;
        }

        el.addClass("mod-complex");

        var contentEl = el.createDiv({ cls: "suggestion-content" });
        contentEl.createDiv({
            text: command.name || command.id,
            cls: "suggestion-title",
        });
        contentEl.createDiv({
            text: command.id,
            cls: "suggestion-note",
        });
    }

    onChooseItem(command) {
        if (typeof this.onChoose === "function") {
            this.onChoose(command);
        }
    }
}

class FileShortcutSuggestModal extends obsidian.FuzzySuggestModal {
    constructor(app, onChoose) {
        super(app);
        this.onChoose = onChoose;
        this.setPlaceholder("Search files in your vault");
    }

    getItems() {
        return this.app.vault.getFiles();
    }

    getItemText(file) {
        return file.path;
    }

    renderSuggestion(match, el) {
        var file = match && match.item ? match.item : match;
        if (!file) {
            return;
        }

        el.addClass("mod-complex");

        var contentEl = el.createDiv({ cls: "suggestion-content" });
        contentEl.createDiv({
            text: file.name,
            cls: "suggestion-title",
        });
        contentEl.createDiv({
            text: file.path,
            cls: "suggestion-note",
        });
    }

    onChooseItem(file) {
        if (typeof this.onChoose === "function") {
            this.onChoose(file);
        }
    }
}

// ── Settings tab ───────────────────────────────────────────────────────
class NNBridgeSettingTab extends obsidian.PluginSettingTab {

    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
        plugin.settingTab = this;
    }

    display() {
        var containerEl = this.containerEl;
        var plugin = this.plugin;
        containerEl.empty();

        containerEl.createEl("p", {
            text: "Toggle visual tweaks for Notebook Navigator. Changes apply instantly.",
            cls: "setting-item-description",
        });

        // ── Shortcuts ──────────────────────────────────────────────
        new obsidian.Setting(containerEl)
            .setHeading()
            .setName("Shortcuts");

        this._addToggle(containerEl, {
            name: "Hide shortcut labels",
            desc: "Hide the text labels on shortcut items, keeping only the icons for a compact icon-only bar.",
            key: "hideShortcutLabels",
        });

        this._addToggle(containerEl, {
            name: "Hide shortcuts section header",
            desc: "Hide the \"Shortcuts\" header row above the pinned shortcuts list.",
            key: "hideShortcutsHeader",
        });

        this._addToggle(containerEl, {
            name: "Hide entire shortcuts section",
            desc: "Hide the full pinned shortcuts container (header + items + banner).",
            key: "hideShortcuts",
        });

        new obsidian.Setting(containerEl)
            .setName("Add command shortcut")
            .setDesc("Pin an Obsidian command into Notebook Navigator's shortcuts list. Reorder it from the Navigator UI like any other shortcut.")
            .addButton(function (button) {
                button
                    .setButtonText("Add command")
                    .onClick(function () {
                        var modal = new CommandShortcutSuggestModal(plugin.app, plugin, async function (command) {
                            try {
                                await plugin.addCommandShortcut(command.id);
                                new obsidian.Notice("Command shortcut added.");
                                plugin.settingTab.display();
                            } catch (error) {
                                new obsidian.Notice(error && error.message ? error.message : "Unable to add command shortcut.");
                            }
                        });

                        if (modal.commands.length === 0) {
                            new obsidian.Notice("No unpinned commands are available.");
                            return;
                        }
                        modal.open();
                    });
            });

        var activeProfileState = plugin._getActiveNNProfileState();
        var commandShortcutEntries = plugin._getCommandShortcutEntries();
        var profileName = activeProfileState && activeProfileState.profile && activeProfileState.profile.name
            ? activeProfileState.profile.name
            : "Unknown";

        containerEl.createEl("p", {
            text: "Command shortcuts for the active Notebook Navigator profile: " + profileName,
            cls: "setting-item-description",
        });

        if (commandShortcutEntries.length === 0) {
            containerEl.createEl("p", {
                text: "No command shortcuts are pinned yet.",
                cls: "setting-item-description",
            });
        } else {
            commandShortcutEntries.forEach(function (entry) {
                var resolvedCommand = plugin._getCommandById(entry.commandId);
                var defaultLabel = resolvedCommand && resolvedCommand.name ? resolvedCommand.name : entry.commandId;

                new obsidian.Setting(containerEl)
                    .setName(entry.label || defaultLabel)
                    .setDesc(entry.commandId + (resolvedCommand ? "" : " (command not found)"))
                    .addText(function (text) {
                        text
                            .setPlaceholder(defaultLabel)
                            .setValue(entry.label || "")
                            .onChange(async function (value) {
                                try {
                                    await plugin.updateCommandShortcut(entry.index, {
                                        label: value.trim(),
                                    });
                                } catch (error) {
                                    new obsidian.Notice(error && error.message ? error.message : "Unable to update command label.");
                                }
                            });
                        text.inputEl.style.width = "180px";
                    })
                    .addText(function (text) {
                        text
                            .setPlaceholder("lucide-command")
                            .setValue(entry.icon === DEFAULT_COMMAND_SHORTCUT_ICON ? "" : (entry.icon || ""))
                            .onChange(async function (value) {
                                try {
                                    await plugin.updateCommandShortcut(entry.index, {
                                        icon: value.trim(),
                                    });
                                } catch (error) {
                                    new obsidian.Notice(error && error.message ? error.message : "Unable to update command icon.");
                                }
                            });
                        text.inputEl.style.width = "160px";
                    })
                    .addExtraButton(function (button) {
                        button
                            .setIcon("trash")
                            .setTooltip("Remove command shortcut")
                            .onClick(async function () {
                                try {
                                    await plugin.removeCommandShortcut(entry.index);
                                    new obsidian.Notice("Command shortcut removed.");
                                    plugin.settingTab.display();
                                } catch (error) {
                                    new obsidian.Notice(error && error.message ? error.message : "Unable to remove command shortcut.");
                                }
                            });
                    });
            });
        }

        // ── Recents ────────────────────────────────────────────────
        new obsidian.Setting(containerEl)
            .setHeading()
            .setName("Recents");

        new obsidian.Setting(containerEl)
            .setName("Hide shortcut files from recents")
            .setDesc(
                "Automatically prevent files that are pinned as Shortcuts from " +
                "appearing in the Recent Notes list. Takes effect immediately for " +
                "new file opens and cleans existing recents."
            )
            .addToggle(function (toggle) {
                toggle
                    .setValue(plugin.settings.hideShortcutsFromRecents)
                    .onChange(function (value) {
                        plugin.settings.hideShortcutsFromRecents = value;
                        plugin.saveSettings();
                        plugin.refreshExclusions();
                    });
            });

        var exclusionListSetting;

        new obsidian.Setting(containerEl)
            .setName("Enable manual recents exclusion")
            .setDesc("Hide additional specific files from the Recent Notes list by name.")
            .addToggle(function (toggle) {
                toggle
                    .setValue(plugin.settings.recentsExclusionEnabled)
                    .onChange(function (value) {
                        plugin.settings.recentsExclusionEnabled = value;
                        plugin.saveSettings();
                        plugin.refreshExclusions();
                        if (exclusionListSetting) {
                            exclusionListSetting.settingEl.style.display = value ? "" : "none";
                        }
                    });
            });

        exclusionListSetting = new obsidian.Setting(containerEl)
            .setName("Excluded file names")
            .setDesc(
                "Enter file names to exclude from recents, one per line. " +
                "Case-insensitive partial matching."
            )
            .addTextArea(function (textArea) {
                textArea
                    .setPlaceholder("Daily Note\nScratchpad\nTemplate")
                    .setValue(plugin.settings.recentsExclusionList)
                    .onChange(function (value) {
                        plugin.settings.recentsExclusionList = value;
                        plugin.saveSettings();
                        plugin.refreshExclusions();
                    });
                textArea.inputEl.rows = 6;
                textArea.inputEl.style.width = "100%";
            });

        if (!plugin.settings.recentsExclusionEnabled) {
            exclusionListSetting.settingEl.style.display = "none";
        }

        // ── Indentation ────────────────────────────────────────────
        new obsidian.Setting(containerEl)
            .setHeading()
            .setName("Indentation");

        var indentSliderSetting;

        new obsidian.Setting(containerEl)
            .setName("Custom indent distance")
            .setDesc("Override the tree indentation width for nested folders and tags.")
            .addToggle(function (toggle) {
                toggle
                    .setValue(plugin.settings.customIndent)
                    .onChange(function (value) {
                        plugin.settings.customIndent = value;
                        plugin.saveSettings();
                        plugin.updateStyle();
                        if (indentSliderSetting) {
                            indentSliderSetting.settingEl.style.display = value ? "" : "none";
                        }
                    });
            });

        indentSliderSetting = new obsidian.Setting(containerEl)
            .setName("Indent distance (px)")
            .setDesc("Width in pixels per indent level (default: 16).")
            .addSlider(function (slider) {
                slider
                    .setLimits(4, 40, 1)
                    .setValue(plugin.settings.indentDistance)
                    .setDynamicTooltip()
                    .onChange(function (value) {
                        plugin.settings.indentDistance = value;
                        plugin.saveSettings();
                        plugin.updateStyle();
                    });
            });

        if (!plugin.settings.customIndent) {
            indentSliderSetting.settingEl.style.display = "none";
        }

        // ── Chevrons ───────────────────────────────────────────────
        new obsidian.Setting(containerEl)
            .setHeading()
            .setName("Chevrons");

        this._addToggle(containerEl, {
            name: "Hide chevrons",
            desc: "Hide the expand/collapse arrow icons on folders and tags.",
            key: "hideChevrons",
        });

        var chevronSizeSlider;

        new obsidian.Setting(containerEl)
            .setName("Custom chevron size")
            .setDesc("Override the size of the expand/collapse arrow icons.")
            .addToggle(function (toggle) {
                toggle
                    .setValue(plugin.settings.customChevronSize)
                    .onChange(function (value) {
                        plugin.settings.customChevronSize = value;
                        plugin.saveSettings();
                        plugin.updateStyle();
                        if (chevronSizeSlider) {
                            chevronSizeSlider.settingEl.style.display = value ? "" : "none";
                        }
                    });
            });

        chevronSizeSlider = new obsidian.Setting(containerEl)
            .setName("Chevron size (px)")
            .setDesc("Size of the arrow icons in pixels (default: 16).")
            .addSlider(function (slider) {
                slider
                    .setLimits(8, 28, 1)
                    .setValue(plugin.settings.chevronSize)
                    .setDynamicTooltip()
                    .onChange(function (value) {
                        plugin.settings.chevronSize = value;
                        plugin.saveSettings();
                        plugin.updateStyle();
                    });
            });

        if (!plugin.settings.customChevronSize) {
            chevronSizeSlider.settingEl.style.display = "none";
        }

        var chevronColorPicker;

        new obsidian.Setting(containerEl)
            .setName("Custom chevron color")
            .setDesc("Override the color of the expand/collapse arrow icons.")
            .addToggle(function (toggle) {
                toggle
                    .setValue(plugin.settings.customChevronColor)
                    .onChange(function (value) {
                        plugin.settings.customChevronColor = value;
                        plugin.saveSettings();
                        plugin.updateStyle();
                        if (chevronColorPicker) {
                            chevronColorPicker.settingEl.style.display = value ? "" : "none";
                        }
                    });
            });

        chevronColorPicker = new obsidian.Setting(containerEl)
            .setName("Chevron color")
            .setDesc("Pick a color for the arrow icons.")
            .addColorPicker(function (picker) {
                picker
                    .setValue(plugin.settings.chevronColor || "#888888")
                    .onChange(function (value) {
                        plugin.settings.chevronColor = value;
                        plugin.saveSettings();
                        plugin.updateStyle();
                    });
            });

        if (!plugin.settings.customChevronColor) {
            chevronColorPicker.settingEl.style.display = "none";
        }

        // ── Navigation ─────────────────────────────────────────────
        new obsidian.Setting(containerEl)
            .setHeading()
            .setName("Navigation");

        this._addToggle(containerEl, {
            name: "Hide vault title",
            desc: "Hide the vault title area displayed below the navigation header.",
            key: "hideVaultTitle",
        });

        this._addToggle(containerEl, {
            name: "Hide note counts",
            desc: "Hide the file/note count badges on folders and tags.",
            key: "hideNoteCounts",
        });

        this._addToggle(containerEl, {
            name: "Hide navigation banner",
            desc: "Hide the banner image at the top of the navigation pane.",
            key: "hideNavBanner",
        });

        this._addToggle(containerEl, {
            name: "Hide section icons",
            desc: "Hide the icons next to navigation section headers.",
            key: "hideSectionIcons",
        });

        this._addToggle(containerEl, {
            name: "Hide navigation separators",
            desc: "Hide the thin horizontal separator lines between navigation sections.",
            key: "hideNavSeparators",
        });

        // ── Sidebar embed ───────────────────────────────────────────
        new obsidian.Setting(containerEl)
            .setHeading()
            .setName("Sidebar embed");

        new obsidian.Setting(containerEl)
            .setName("Enable sidebar markdown embed")
            .setDesc("Render pasted markdown (including ```button blocks) in Notebook Navigator sidebar.")
            .addToggle(function (toggle) {
                toggle
                    .setValue(plugin.settings.sidebarEmbedEnabled)
                    .onChange(async function (value) {
                        plugin.settings.sidebarEmbedEnabled = value;
                        await plugin.saveSettings();
                        await plugin.refreshSidebarEmbed();
                    });
            });

        new obsidian.Setting(containerEl)
            .setName("Embed title")
            .setDesc("Optional section title shown above rendered markdown.")
            .addText(function (text) {
                text
                    .setPlaceholder("Quick actions")
                    .setValue(plugin.settings.sidebarEmbedTitle || "")
                    .onChange(async function (value) {
                        plugin.settings.sidebarEmbedTitle = value;
                        await plugin.saveSettings();
                        await plugin.refreshSidebarEmbed();
                    });
                text.inputEl.style.width = "100%";
            });

        new obsidian.Setting(containerEl)
            .setName("Embed position")
            .setDesc("Place the rendered block at top or bottom of the navigation pane.")
            .addDropdown(function (dropdown) {
                dropdown
                    .addOption("top", "Top")
                    .addOption("bottom", "Bottom")
                    .setValue(plugin.settings.sidebarEmbedPosition || "bottom")
                    .onChange(async function (value) {
                        plugin.settings.sidebarEmbedPosition = value;
                        await plugin.saveSettings();
                        await plugin.refreshSidebarEmbed();
                    });
            });

        new obsidian.Setting(containerEl)
            .setName("Embed top spacing (px)")
            .setDesc("Move the embed section higher/lower by adjusting its top spacing.")
            .addSlider(function (slider) {
                slider
                    .setLimits(-50, 50, 1)
                    .setValue(typeof plugin.settings.sidebarEmbedTopSpacing === "number" ? plugin.settings.sidebarEmbedTopSpacing : 8)
                    .setDynamicTooltip()
                    .onChange(async function (value) {
                        plugin.settings.sidebarEmbedTopSpacing = value;
                        await plugin.saveSettings();
                        await plugin.refreshSidebarEmbed();
                    });
            });

        new obsidian.Setting(containerEl)
            .setName("Insert after selector (advanced)")
            .setDesc("Optional CSS selector inside .nn-navigation-pane. Embed is inserted after first match.")
            .addText(function (text) {
                text
                    .setPlaceholder(".nn-shortcut-pinned")
                    .setValue(plugin.settings.sidebarEmbedAfterSelector || "")
                    .onChange(async function (value) {
                        plugin.settings.sidebarEmbedAfterSelector = value;
                        await plugin.saveSettings();
                        await plugin.refreshSidebarEmbed();
                    });
                text.inputEl.style.width = "100%";
            });

        new obsidian.Setting(containerEl)
            .setName("Sidebar markdown")
            .setDesc("Paste markdown to render in the sidebar. Supports Buttons plugin code blocks.")
            .addTextArea(function (textArea) {
                textArea
                    .setPlaceholder("```button\nname New note\ntype command\naction Templater: Insert newnotetemp\n```")
                    .setValue(plugin.settings.sidebarEmbedMarkdown || "")
                    .onChange(async function (value) {
                        plugin.settings.sidebarEmbedMarkdown = value;
                        await plugin.saveSettings();
                        await plugin.refreshSidebarEmbed();
                    });
                textArea.inputEl.rows = 10;
                textArea.inputEl.style.width = "100%";
            });

        // ── Sidebar Tabs (Notion-like) ──────────────────────────────
        new obsidian.Setting(containerEl)
            .setHeading()
            .setName("Sidebar Tabs (Notion-like)");

        this._addToggle(containerEl, {
            name: "Flatten sidebar tabs style",
            desc: "Removes default folder-tab styling to make it look like a sleek Notion action row.",
            key: "sidebarTabsStyleEnabled",
        });

        new obsidian.Setting(containerEl)
            .setName("Override sidebar tab icons")
            .setDesc("Enable custom icons for native left sidebar tabs.")
            .addToggle(function (toggle) {
                toggle
                    .setValue(plugin.settings.sidebarTabIconsEnabled)
                    .onChange(async function (value) {
                        plugin.settings.sidebarTabIconsEnabled = value;
                        await plugin.saveSettings();
                        plugin._refreshSidebarTabs();
                    });
            });

        new obsidian.Setting(containerEl)
            .setName("Custom tab icons (Format: data-type: icon-name)")
            .setDesc("One per line. Example: notebook-navigator: menu")
            .addTextArea(function (textArea) {
                textArea
                    .setPlaceholder("notebook-navigator: menu\nsearch: search")
                    .setValue(plugin.settings.sidebarTabIcons || "")
                    .onChange(async function (value) {
                        plugin.settings.sidebarTabIcons = value;
                        await plugin.saveSettings();
                        plugin._refreshSidebarTabs();
                    });
                textArea.inputEl.rows = 3;
                textArea.inputEl.style.width = "100%";
            });

        new obsidian.Setting(containerEl)
            .setName("Inject custom commands")
            .setDesc("Add command buttons to the left sidebar tab container.")
            .addToggle(function (toggle) {
                toggle
                    .setValue(plugin.settings.sidebarTabCommandsEnabled)
                    .onChange(async function (value) {
                        plugin.settings.sidebarTabCommandsEnabled = value;
                        await plugin.saveSettings();
                        plugin._refreshSidebarTabs();
                    });
            });

        new obsidian.Setting(containerEl)
            .setName("Sidebar commands (Format: Label: Icon: CommandID)")
            .setDesc("One per line. Example: New note: file-plus: file-explorer:new-file")
            .addTextArea(function (textArea) {
                textArea
                    .setPlaceholder("New note: file-plus: file-explorer:new-file\nSettings: settings: app:open-settings")
                    .setValue(plugin.settings.sidebarTabCommands || "")
                    .onChange(async function (value) {
                        plugin.settings.sidebarTabCommands = value;
                        await plugin.saveSettings();
                        plugin._refreshSidebarTabs();
                    });
                textArea.inputEl.rows = 4;
                textArea.inputEl.style.width = "100%";
            });

        // ── Custom Sections ───────────────────────────────────────────
        containerEl.createEl("h3", { text: "Custom Sections" });

        new obsidian.Setting(containerEl)
            .setName("Section Placement")
            .setDesc("Where should the custom sections be injected in the navigation pane?")
            .addDropdown(function (dropdown) {
                dropdown
                    .addOption("top", "Top (Above everything)")
                    .addOption("below-shortcuts", "Below Pinned Shortcuts")
                    .addOption("bottom", "Bottom (Below everything)")
                    .addOption("custom", "Custom CSS Selector")
                    .setValue(plugin.settings.customSectionsPosition || "below-shortcuts")
                    .onChange(async function (value) {
                        plugin.settings.customSectionsPosition = value;
                        await plugin.saveSettings();
                        plugin.settingTab.display();
                        plugin.refreshCustomSections();
                    });
            });

        if (plugin.settings.customSectionsPosition === "custom") {
            new obsidian.Setting(containerEl)
                .setName("Custom Target Selector")
                .setDesc("Insert custom sections AFTER this CSS selector (e.g., .nn-shortcut-pinned)")
                .addText(function (text) {
                    text
                        .setPlaceholder(".nn-shortcut-pinned")
                        .setValue(plugin.settings.customSectionsSelector || "")
                        .onChange(async function (value) {
                            plugin.settings.customSectionsSelector = value;
                            await plugin.saveSettings();
                            plugin.refreshCustomSections();
                        });
                });
        }

        new obsidian.Setting(containerEl)
            .setName("Add custom section")
            .setDesc("Create a new custom collapsible section to organize note and command shortcuts.")
            .addButton(function (button) {
                button
                    .setButtonText("Create Section")
                    .onClick(async function () {
                        if (!Array.isArray(plugin.settings.customSections)) {
                            plugin.settings.customSections = [];
                        }
                        var newSection = {
                            id: "sec_" + Date.now() + "_" + Math.random().toString(36).substr(2, 5),
                            title: "New Section",
                            icon: "folder",
                            collapsible: true,
                            collapsed: false,
                            items: []
                        };
                        plugin.settings.customSections.push(newSection);
                        await plugin.saveSettings();
                        plugin.settingTab.display();
                        plugin.refreshCustomSections();
                    });
            });

        if (Array.isArray(plugin.settings.customSections) && plugin.settings.customSections.length > 0) {
            plugin.settings.customSections.forEach(function (section, sectionIndex) {
                // Outer container for section settings box
                var secDiv = containerEl.createDiv({ cls: "nn-bridge-section-settings-box" });
                secDiv.style.border = "1px solid var(--background-modifier-border)";
                secDiv.style.padding = "12px";
                secDiv.style.margin = "12px 0";
                secDiv.style.borderRadius = "8px";
                secDiv.style.background = "var(--background-primary-alt)";

                // Section header setting
                var secHeader = new obsidian.Setting(secDiv)
                    .setName("Section: " + (section.title || "Untitled"))
                    .addToggle(function (toggle) {
                        toggle
                            .setTooltip("Collapsible")
                            .setValue(section.collapsible !== false)
                            .onChange(async function (val) {
                                section.collapsible = val;
                                await plugin.saveSettings();
                                plugin.refreshCustomSections();
                            });
                    })
                    .addToggle(function (toggle) {
                        toggle
                            .setTooltip("Hide Header")
                            .setValue(section.hideHeader === true)
                            .onChange(async function (val) {
                                section.hideHeader = val;
                                await plugin.saveSettings();
                                plugin.refreshCustomSections();
                            });
                    })
                    .addButton(function (btn) {
                        btn.setButtonText("↑").setTooltip("Move Up").onClick(async function () {
                            if (sectionIndex > 0) {
                                var temp = plugin.settings.customSections[sectionIndex];
                                plugin.settings.customSections[sectionIndex] = plugin.settings.customSections[sectionIndex - 1];
                                plugin.settings.customSections[sectionIndex - 1] = temp;
                                await plugin.saveSettings();
                                plugin.settingTab.display();
                                plugin.refreshCustomSections();
                            }
                        });
                    })
                    .addButton(function (btn) {
                        btn.setButtonText("↓").setTooltip("Move Down").onClick(async function () {
                            if (sectionIndex < plugin.settings.customSections.length - 1) {
                                var temp = plugin.settings.customSections[sectionIndex];
                                plugin.settings.customSections[sectionIndex] = plugin.settings.customSections[sectionIndex + 1];
                                plugin.settings.customSections[sectionIndex + 1] = temp;
                                await plugin.saveSettings();
                                plugin.settingTab.display();
                                plugin.refreshCustomSections();
                            }
                        });
                    })
                    .addButton(function (btn) {
                        btn.setIcon("trash").setTooltip("Delete Section").onClick(async function () {
                            plugin.settings.customSections.splice(sectionIndex, 1);
                            await plugin.saveSettings();
                            plugin.settingTab.display();
                            plugin.refreshCustomSections();
                        });
                    });

                // Section Details: Title & Icon
                new obsidian.Setting(secDiv)
                    .setName("Title")
                    .addText(function (text) {
                        text.setValue(section.title || "")
                            .onChange(async function (val) {
                                section.title = val;
                                secHeader.setName("Section: " + (val || "Untitled"));
                                await plugin.saveSettings();
                                plugin.refreshCustomSections();
                            });
                    });

                new obsidian.Setting(secDiv)
                    .setName("Icon")
                    .setDesc("Lucide icon name (e.g. folder, star, list, command)")
                    .addText(function (text) {
                        text.setValue(section.icon || "folder")
                            .onChange(async function (val) {
                                section.icon = val;
                                await plugin.saveSettings();
                                plugin.refreshCustomSections();
                            });
                    });

                // Sub-panel for Section Items
                var itemsDiv = secDiv.createDiv({ cls: "nn-bridge-section-items-settings" });
                itemsDiv.createEl("h5", { text: "Shortcuts/Items" });

                if (!Array.isArray(section.items)) {
                    section.items = [];
                }

                if (section.items.length === 0) {
                    itemsDiv.createEl("p", { text: "No items added to this section.", cls: "setting-item-description" });
                } else {
                    section.items.forEach(function (item, itemIndex) {
                        var itemSetting = new obsidian.Setting(itemsDiv)
                            .setName((item.name || item.pathOrId || "Untitled") + " (" + item.type + ")")
                            .addText(function (text) {
                                text.setPlaceholder("Custom Label")
                                    .setValue(item.name || "")
                                    .onChange(async function (val) {
                                        item.name = val;
                                        await plugin.saveSettings();
                                        plugin.refreshCustomSections();
                                    });
                                text.inputEl.style.width = "120px";
                            })
                            .addText(function (text) {
                                text.setPlaceholder("Icon override (lucide)")
                                    .setValue(item.icon || "")
                                    .onChange(async function (val) {
                                        item.icon = val;
                                        await plugin.saveSettings();
                                        plugin.refreshCustomSections();
                                    });
                                text.inputEl.style.width = "100px";
                            })
                            .addButton(function (btn) {
                                btn.setButtonText("↑").onClick(async function () {
                                    if (itemIndex > 0) {
                                        var temp = section.items[itemIndex];
                                        section.items[itemIndex] = section.items[itemIndex - 1];
                                        section.items[itemIndex - 1] = temp;
                                        await plugin.saveSettings();
                                        plugin.settingTab.display();
                                        plugin.refreshCustomSections();
                                    }
                                });
                            })
                            .addButton(function (btn) {
                                btn.setButtonText("↓").onClick(async function () {
                                    if (itemIndex < section.items.length - 1) {
                                        var temp = section.items[itemIndex];
                                        section.items[itemIndex] = section.items[itemIndex + 1];
                                        section.items[itemIndex + 1] = temp;
                                        await plugin.saveSettings();
                                        plugin.settingTab.display();
                                        plugin.refreshCustomSections();
                                    }
                                });
                            })
                            .addExtraButton(function (btn) {
                                btn.setIcon("trash").setTooltip("Remove Item").onClick(async function () {
                                    section.items.splice(itemIndex, 1);
                                    await plugin.saveSettings();
                                    plugin.settingTab.display();
                                    plugin.refreshCustomSections();
                                });
                            });
                    });
                }

                // Add item buttons
                var btnGroup = secDiv.createDiv({ cls: "nn-bridge-section-add-item-group" });
                btnGroup.style.display = "flex";
                btnGroup.style.gap = "8px";
                btnGroup.style.marginTop = "8px";

                var addNoteBtn = document.createElement("button");
                addNoteBtn.textContent = "Add Note";
                addNoteBtn.className = "mod-cta";
                addNoteBtn.addEventListener("click", function () {
                    var modal = new FileShortcutSuggestModal(plugin.app, async function (file) {
                        section.items.push({
                            id: "item_" + Date.now() + "_" + Math.random().toString(36).substr(2, 5),
                            type: "note",
                            pathOrId: file.path,
                            name: file.name.replace(/\.[^.]+$/, ""),
                            icon: "file-text"
                        });
                        await plugin.saveSettings();
                        plugin.settingTab.display();
                        plugin.refreshCustomSections();
                    });
                    modal.open();
                });
                btnGroup.appendChild(addNoteBtn);

                var addCmdBtn = document.createElement("button");
                addCmdBtn.textContent = "Add Command";
                addCmdBtn.className = "mod-cta";
                addCmdBtn.addEventListener("click", function () {
                    var modal = new CommandShortcutSuggestModal(plugin.app, plugin, async function (command) {
                        section.items.push({
                            id: "item_" + Date.now() + "_" + Math.random().toString(36).substr(2, 5),
                            type: "command",
                            pathOrId: command.id,
                            name: command.name,
                            icon: "terminal"
                        });
                        await plugin.saveSettings();
                        plugin.settingTab.display();
                        plugin.refreshCustomSections();
                    });
                    modal.open();
                });
                btnGroup.appendChild(addCmdBtn);
            });
        }
    }

    _addToggle(containerEl, opts) {
        var plugin = this.plugin;
        new obsidian.Setting(containerEl)
            .setName(opts.name)
            .setDesc(opts.desc)
            .addToggle(function (toggle) {
                toggle
                    .setValue(plugin.settings[opts.key])
                    .onChange(function (value) {
                        plugin.settings[opts.key] = value;
                        plugin.saveSettings();
                        plugin.updateStyle();
                    });
            });
    }
}

module.exports = NNBridgePlugin;
