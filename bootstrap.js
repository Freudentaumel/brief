'use strict';

Components.utils.import('resource://gre/modules/Services.jsm');
Components.utils.import('resource://gre/modules/FileUtils.jsm');
Components.utils.import('resource://gre/modules/XPCOMUtils.jsm');

Components.utils.import('resource://brief/common.jsm');
Components.utils.import('resource://brief/Prefs.jsm');
Components.utils.import('resource://brief/Storage.jsm');
Components.utils.import('resource://brief/FeedUpdateService.jsm');
Components.utils.import('resource://brief/API.jsm');

XPCOMUtils.defineLazyModuleGetter(this, 'RecentWindow', 'resource:///modules/RecentWindow.jsm');


var Brief = {

    content_server: null,
    webext_port: null,

    FIRST_RUN_PAGE_URL: 'chrome://brief/content/firstrun.xhtml',

    BRIEF_OPTIONS_URL: 'chrome://brief/content/options/options.xul',

    get window() { return RecentWindow.getMostRecentBrowserWindow() },

    get toolbarbutton() { return document.getElementById('brief-button') },

    get prefs() {
        delete this.prefs;
        return this.prefs = Services.prefs.getBranch('extensions.brief.');
    },

    get common() {
        let tempScope = {};
        Components.utils.import('resource://brief/common.jsm', tempScope);

        delete this.common;
        return this.common = tempScope;
    },

    open: function Brief_open(aInCurrentTab) {
        let gBrowser = this.window.gBrowser;
        let loading = gBrowser.webProgress.isLoadingDocument;
        let blank = this.window.isBlankPageURL(gBrowser.currentURI.spec);
        let briefTab = this.getBriefTab();

        if (briefTab)
            gBrowser.selectedTab = briefTab;
        else if (blank && !loading || aInCurrentTab)
            gBrowser.loadURI(this.common.BRIEF_URL, null, null);
        else
            gBrowser.loadOneTab(this.common.BRIEF_URL, { inBackground: false });
    },

    getBriefTab: function Brief_getBriefTab() {
        let gBrowser = this.window.gBrowser;
        for (let tab of gBrowser.tabs) {
            if (gBrowser.getBrowserForTab(tab).currentURI.spec == this.common.BRIEF_URL)
                return tab;
        }

        return null;
    },

    showOptions: function cmd_showOptions() {
        let windows = Services.wm.getEnumerator(null);
        while (windows.hasMoreElements()) {
            let win = windows.getNext();
            if (win.document.documentURI == Brief.BRIEF_OPTIONS_URL) {
                win.focus();
                return;
            }
        }

        let features = 'chrome,titlebar,toolbar,centerscreen,';
        this.window.openDialog(Brief.BRIEF_OPTIONS_URL, 'Brief options', features);
    },

    registerContentHandler: function Brief_registerContentHandler() {
        // Register Brief as a content handler for feeds. Can't do it in the
        // service component because the registrar doesn't work yet.
        const CONTENT_TYPE = 'application/vnd.mozilla.maybe.feed';
        const OLD_SUBSCRIBE_URL = 'brief://subscribe/%s';
        const SUBSCRIBE_URL = this.common.BRIEF_URL + '?subscribe=%s';

        let wccs = Cc['@mozilla.org/embeddor.implemented/web-content-handler-registrar;1']
                   .getService(Ci.nsIWebContentConverterService);

        // Temporary for migration from older versions
        if (wccs.getWebContentHandlerByURI(CONTENT_TYPE, OLD_SUBSCRIBE_URL)) {
            wccs.removeContentHandler(CONTENT_TYPE, SUBSCRIBE_URL, 'Brief', null);
            // Sorry, removing the handler with removeContentHandler is
            // incomplete (Mozilla bug 1145832), so we finish removing it manually
            try {
                let branch = Services.prefs.getBranch("browser.contentHandlers.types.");
                branch.getChildList("")
                    .filter(child => !!(/^(\d+)\.uri$/.exec(child)))
                    .filter(child => (branch.getCharPref(child, null) === OLD_SUBSCRIBE_URL))
                    .map(child => /^(\d+)\.uri$/.exec(child)[1])
                    .forEach(child => {
                        branch.getChildList(child).forEach(item => branch.clearUserPref(item));
                    });
            } catch(e) {
                console.error("could not remove old handler:", e);
            }
        }
        if (!wccs.getWebContentHandlerByURI(CONTENT_TYPE, SUBSCRIBE_URL))
            wccs.registerContentHandler(CONTENT_TYPE, SUBSCRIBE_URL, 'Brief', null);
    },

    onPrefChanged: function Brief_onPrefChanged(aSubject, aTopic, aData) {
        if (aData == 'showUnreadCounter') {
            Brief.initUnreadCounter();
        }
    },


    observeStorage: function(event, args) {
        switch(event) {
            case 'entriesAdded':
            case 'entriesUpdated':
            case 'entriesMarkedRead':
            case 'entriesDeleted':
                this.refreshUI();
        }
    },

    initUnreadCounter: function() {
        let showCounter = this.prefs.getBoolPref('showUnreadCounter');

        if(this.webext_port !== null)
            this.webext_port.postMessage({id: 'set-show-unread-counter', state: showCounter});
    },

    refreshUI: function Brief_refreshUI() {
        wait(500).then(() => Brief.updateStatus());
    },

    updateStatus: async function Brief_updateStatus() {
        let count_query = new Query({
            includeFeedsExcludedFromGlobalViews: false,
            deleted: false,
            read: false
        });

        let count = await count_query.getEntryCount();
        if(this.webext_port !== null)
            this.webext_port.postMessage({id: 'set-unread-count', count});

        let updated = "";
        let bundle = Services.strings.createBundle('chrome://brief/locale/brief.properties');

        let lastUpdateTime = this.prefs.getIntPref('update.lastUpdateTime') * 1000;
        let date = new Date(lastUpdateTime);
        let relativeDate = new this.common.RelativeDate(lastUpdateTime);

        let time, pluralForms, form;

        switch (true) {
            case relativeDate.deltaMinutes === 0:
                updated = bundle.GetStringFromName('lastUpdated.rightNow');
                break;

            case relativeDate.deltaHours === 0:
                pluralForms = bundle.GetStringFromName('minute.pluralForms');
                form = this.common.getPluralForm(relativeDate.deltaMinutes, pluralForms);
                updated = bundle.formatStringFromName('lastUpdated.ago', [form], 1)
                                    .replace('#number', relativeDate.deltaMinutes);
                break;

            case relativeDate.deltaHours <= 12:
                pluralForms = bundle.GetStringFromName('hour.pluralForms');
                form = this.common.getPluralForm(relativeDate.deltaHours, pluralForms);
                updated = bundle.formatStringFromName('lastUpdated.ago', [form], 1)
                                    .replace('#number', relativeDate.deltaHours);
                break;

            case relativeDate.deltaDaySteps === 0:
                time = date.toLocaleFormat('%X').replace(/:\d\d$/, ' ');
                updated = bundle.formatStringFromName('lastUpdated.today', [time], 1);
                break;

            case relativeDate.deltaDaySteps === 1:
                time = date.toLocaleFormat('%X').replace(/:\d\d$/, ' ');
                updated = bundle.formatStringFromName('lastUpdated.yesterday', [time], 1);
                break;

            case relativeDate.deltaDaySteps < 7:
                pluralForms = bundle.GetStringFromName('day.pluralForms');
                form = this.common.getPluralForm(relativeDate.deltaDays, pluralForms);
                updated = bundle.formatStringFromName('lastUpdated.ago', [form], 1)
                                    .replace('#number', relativeDate.deltaDays);
                break;

            case relativeDate.deltaYearSteps === 0:
                time = date.toLocaleFormat('%d %B').replace(/^0/, '');
                updated = bundle.formatStringFromName('lastUpdated.fullDate', [time], 1);
                break;

            default:
                time = date.toLocaleFormat('%d %B %Y').replace(/^0/, '');
                updated = bundle.formatStringFromName('lastUpdated.fullDate', [time], 1);
                break;
        }

        let rows = [];

        let feeds_query = new Query({
            deleted: false,
            read: false,
            sortOrder: 'library',
            sortDirection: 'asc'
        })

        let unreadFeeds = await feeds_query.getProperty('feedID', true);

        let noUnreadText = "";
        if(unreadFeeds.length == 0)
            noUnreadText = bundle.GetStringFromName('noUnreadFeedsTooltip');

        for (let feed of unreadFeeds) {
            let feedName = Storage.getFeed(feed).title;
            if(feedName.length > 24)
                feedName = feedName.substring(0, 24) + "...";

            let query = new Query({
                deleted: false,
                feeds: [feed],
                read: false
            })

            rows.push(query.getEntryCount().then(count => `${count}\t\t${feedName}`));
        }
        rows = await Promise.all(rows);
        let tooltip = `${updated}\n\n${noUnreadText}${rows.join('\n')}`;
        if(this.webext_port !== null)
            this.webext_port.postMessage({id: 'set-tooltip', text: tooltip});
    },

    onFirstRun: function Brief_onFirstRun() {
        this.prefs.setBoolPref('firstRun', false);

        // Load the first run page.
        wait().then(() => {
            let parameters = { relatedToCurrent: false, inBackground: false };
            this.window.gBrowser.loadOneTab(Brief.FIRST_RUN_PAGE_URL, parameters)
        })
    },

    onWebextMessage: function Brief_onWebextMessage(message) {
        // Processing messages from the WebExtension component
        switch(message.id) {
            case 'open-brief':
                this.open();
                break;
            case 'open-options':
                this.showOptions();
                break;
            case 'refresh':
                FeedUpdateService.updateAllFeeds();
                break;
            case 'mark-all-read':
                (new Query()).markEntriesRead(true);
                break;
            case 'set-show-unread-counter':
                Brief.prefs.setBoolPref('showUnreadCounter', message.state);
                break;
            case 'get-show-unread-counter':
                this.initUnreadCounter();
                break;
            case 'get-summary':
                this.updateStatus();
                break;
            default:
                console.log("Unknown command " + message.id);
        }
    },

    startup: function({webExtension}) {
        // Start the embedded webextension.
        console.log("Brief: extension startup");

        // Load default prefs
        PrefLoader.setDefaultPrefs();

        Services.obs.addObserver(this.refreshUI, 'brief:invalidate-feedlist', false);

        // Initialize storage and API
        Storage.init();
        FeedUpdateService.init();
        this.content_server = new BriefServer();

        this.prefs.addObserver('', this.onPrefChanged, false);

        // Register the custom CSS file under a resource URI.
        let resourceProtocolHandler = Services.io.getProtocolHandler('resource')
                                                .QueryInterface(Ci.nsIResProtocolHandler);
        let file = FileUtils.getFile('ProfD', ['chrome', 'brief-custom-style.css']);
        let uri = Services.io.newFileURI(file);
        resourceProtocolHandler.setSubstitution('brief-custom-style.css', uri);

        // Register the content handler for feeds
        this.registerContentHandler();

        // Trigger async livemarks sync
        wait(1000).then(() => Storage.syncWithLivemarks());

        // Async startup after Storage is ready
        Storage.ready.then(() => {
            Storage.addObserver(this);
            this.updateStatus();
        });

        // Start the WebExtension component
        webExtension.startup().then(({browser}) => {
            browser.runtime.onConnect.addListener(port => {
                this.webext_port = port;
                // Won't need to remove this one, the WebExtension will be down first
                this.webext_port.onMessage.addListener(message => this.onWebextMessage(message));
            });
        });

        if (this.prefs.getBoolPref('firstRun')) {
            this.onFirstRun();
        }
    },

    shutdown: function() {
        Services.obs.notifyObservers(null, "startupcache-invalidate", null); //XXX: dirty hack for quicker development to avoid bootstrap.js caching
        Services.obs.notifyObservers(null, "chrome-flush-caches", null); // Hack taken from MDN
        Services.strings.flushBundles();
        console.log("Brief: extension shutdown");

        // Unregister the custom CSS file
        let resourceProtocolHandler = Services.io.getProtocolHandler('resource')
                                                .QueryInterface(Ci.nsIResProtocolHandler);
        resourceProtocolHandler.setSubstitution('brief-custom-style.css', null);

        this.prefs.removeObserver('', this.onPrefChanged);

        this.content_server.finalize();
        FeedUpdateService.finalize();
        Storage.finalize();

        Services.obs.removeObserver(this.refreshUI, 'brief:invalidate-feedlist');
        Storage.removeObserver(this); // Nop if not registered yet
        Storage = null; // Stop async callback from registering after this point

        // Clear default prefs
        PrefLoader.clearDefaultPrefs();

        console.log("Brief: JSM unload"); // Unload all of our JSMs
        Components.utils.unload('resource://brief/API.jsm');
        Components.utils.unload('resource://brief/common.jsm');
        Components.utils.unload('resource://brief/Storage.jsm');
        Components.utils.unload('resource://brief/FeedUpdateService.jsm');
        Components.utils.unload('resource://brief/DatabaseSchema.jsm');
        Components.utils.unload('resource://brief/opml.jsm');
        Components.utils.unload('resource://brief/Prefs.jsm');
    }

}

function startup(data) {
    Brief.startup(data);
}

function shutdown(data) {
    Brief.shutdown(data);
}
