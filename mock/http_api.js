'use strict';

var url = require('url'),
    sleep = require('./node_modules/sleep'),
    _ = require('../app/lib/lodash.js')._,
    jsonpatch = require('../app/lib/jsonpatch.js'),
    helpers = require('../app/js/helpers.js'),
      makeLogger = helpers.makeLogger,
        log = makeLogger('api'),
      asjsonpatch = helpers.asjsonpatch,
      getByPath = helpers.getByPath,
    scenarios = require('./scenarios'),
      SCENARIOS = scenarios.SCENARIOS,
    constants = require('../app/js/constants.js'),
      EMAIL = constants.INPUT_PAT.EMAIL,
      LANG = constants.LANG,
      ENUMS = constants.ENUMS,
        CONNECTIVITY = ENUMS.CONNECTIVITY,
        INTERACTION = ENUMS.INTERACTION,
        MODAL = ENUMS.MODAL,
        MODE = ENUMS.MODE,
        OS = ENUMS.OS,
        SETTING = ENUMS.SETTING;

var SKIPSETUP = true,
    MODALSEQ_GIVE = [MODAL.welcome, MODAL.authorize, MODAL.lanternFriends, MODAL.finished, MODAL.none],
    MODALSEQ_GET = [MODAL.welcome, MODAL.authorize, MODAL.lanternFriends, MODAL.proxiedSites, MODAL.systemProxy, MODAL.finished, MODAL.none];

// XXX refactor bayeuxbackend vs httpapi vs model
// XXX better name?
function ApiServlet(bayeuxBackend) {
  this.bayeuxBackend = bayeuxBackend;
  this.reset();
  this.DEFAULT_PROXIED_SITES = bayeuxBackend.model.settings.proxiedSites.slice(0);
}

ApiServlet.VERSION = {
  major: 0,
  minor: 0,
  patch: 1
  };
ApiServlet.MOUNT_POINT = 'api';

ApiServlet.RESET_INTERNAL_STATE = {
  lastModal: MODAL.none,
  appliedScenarios: {
    os: 'osx',
    location: 'nyc',
    internet: 'true',
    updateAvailable: 'true',
    gtalkAuthorized: 'true',
    invited: 'true',
    ninvites: '10',
    gtalkReachable: 'true',
    roster: 'roster1',
    friends: 'friends1',
    peers: 'peers1',
    countries: 'countries1'
  }
};

ApiServlet.prototype.reset = function() {
  this._internalState = _.cloneDeep(ApiServlet.RESET_INTERNAL_STATE);
  this._internalState.modalsCompleted = {
    welcome: SKIPSETUP,
    authorize: SKIPSETUP,
    proxiedSites: SKIPSETUP,
    systemProxy: SKIPSETUP,
    lanternFriends: SKIPSETUP,
    finished: SKIPSETUP
  };
  this.bayeuxBackend.resetModel();
  this.model = this.bayeuxBackend.model;
  this.model.version.installed.httpApi = ApiServlet.VERSION;
  this.model.mock = {scenarios: {applied: {}, all: SCENARIOS}};
  var applied = this._internalState.appliedScenarios;
  for (var groupKey in applied) {
    var groupObj = getByPath(SCENARIOS, '/'+groupKey),
        scenKey = applied[groupKey],
        scenObj = groupObj[scenKey];
    if (groupObj._applyImmediately || scenObj._applyImmediately)
      scenObj.func.call(this);
    this.model.mock.scenarios.applied[groupKey] = scenKey;
  }
  this.sync();
  if (SKIPSETUP) {
    this.sync({'/showVis': true, '/settings/mode': MODE.give});
    ApiServlet._handlerForModal[MODAL.authorize].call(this, INTERACTION.continue);
  }
};

ApiServlet.prototype.sync = function(patch) {
  if (_.isArray(patch)) {
    jsonpatch.apply(this.model, patch);
  } else if (_.isPlainObject(patch)) {
    patch = asjsonpatch(patch);
    jsonpatch.apply(this.model, patch);
  }
  this.bayeuxBackend.publishSync(patch);
};

/*
 * Show next modal that should be shown, including possibly MODAL.none.
 * Needed because some modals can be skipped if the user is
 * unable to complete them, but should be returned to later.
 * */
ApiServlet.prototype._advanceModal = function(backToIfNone) {
  var modalSeq = this.inGiveMode() ? MODALSEQ_GIVE : MODALSEQ_GET,
      next;
  for (var i=0; this._internalState.modalsCompleted[next=modalSeq[i++]];);
  if (backToIfNone && next == MODAL.none)
    next = backToIfNone;
  this.sync({'/modal': next});
};


ApiServlet.prototype.inCensoringCountry = function() {
  return this.model.countries[this.model.location.country].censors;
};

ApiServlet.prototype.inGiveMode = function() {
  return this.model.settings.mode == MODE.give;
};

ApiServlet.prototype.inGetMode = function() {
  return this.model.settings.mode == MODE.get;
};


ApiServlet._handlerForInteraction = {};

var _globalModals = {};
_globalModals[INTERACTION.updateAvailable] = MODAL.updateAvailable;
_globalModals[INTERACTION.about] = MODAL.about;
_globalModals[INTERACTION.contact] = MODAL.contact;
_globalModals[INTERACTION.lanternFriends] = MODAL.lanternFriends;
_globalModals[INTERACTION.proxiedSites] = MODAL.proxiedSites;
_globalModals[INTERACTION.settings] = MODAL.settings;
_globalModals[INTERACTION.scenarios] = MODAL.scenarios;
_.forEach(_globalModals, function(modal, interaction) {
  ApiServlet._handlerForInteraction[interaction] = function(res, data) {
    if (this.model.modal == modal) return;
    this._internalState.lastModal = this.model.modal;
    this.sync({'/modal': modal});
  };
});

ApiServlet._handlerForInteraction[INTERACTION.close] = function(res, data) {
  this.sync({'/modal': this._internalState.lastModal});
  this._internalState.lastModal = MODAL.none;
};

// XXX update to new patch changes
/*
ApiServlet._handlerForInteraction[INTERACTION.developer] = function(res, data) {
  if (!_.isArray(data)) throw Error('Expected array');
  // XXX validate requested updates
  for (var i=0, update=data[i]; update; update=data[++i]) {
    if (update.delete) {
      deleteByPath(this.model, update.path);
    } else {
      deleteByPath(this.model, update.path);
      merge(this.model, update.value, update.path);
    }
    this.publishSync(update.path);
  }
};
*/

ApiServlet._handlerForModal = {};
ApiServlet._handlerForModal[MODAL.contact] = function(interaction, res, data) {
  if (interaction != INTERACTION.continue && interaction != INTERACTION.cancel) {
    res.writeHead(400);
    return;
  }
  if (interaction == INTERACTION.continue) {
    log('received message:', data.message);
    // XXX notify user message was sent in an alert
  }
  this.sync({'/modal': this._internalState.lastModal});
  this._internalState.lastModal = MODAL.none;
};

ApiServlet._handlerForModal[MODAL.scenarios] = function(interaction, res, data) {
  if (interaction == INTERACTION.cancel) {
    this.sync({'/modal': this._internalState.lastModal});
    this._internalState.lastModal = MODAL.none;
    return;
  }
  if (interaction != INTERACTION.continue ||
     (data.path && data.path != '/mock/scenarios/applied')) {
    res.writeHead(400);
    return;
  }
  var appliedScenarios = data.value;
  for (var groupKey in appliedScenarios) {
    var scenKey = appliedScenarios[groupKey];
    if (!getByPath(SCENARIOS, '/'+groupKey+'/'+scenKey)) {
      log('No such scenario', '/'+groupKey+'/'+scenKey);
      res.writeHead(400);
      return;
    }
    if (getByPath(this.model, '/mock/scenarios/applied/'+groupKey) != scenKey) {
      var scen = getByPath(SCENARIOS, '/'+groupKey+'/'+scenKey);
      log('applying scenario:', scen.desc);
      scen.func.call(this);
    }
  }
  this.sync({
    '/mock/scenarios/applied': appliedScenarios,
    '/mock/scenarios/prompt': '',
    '/modal': this._internalState.lastModal});
  this._internalState.lastModal = MODAL.none;
};


ApiServlet._handlerForModal[MODAL.welcome] = function(interaction, res, data) {
  if (!(interaction in MODE)) return res.writeHead(400);
  if (interaction == INTERACTION.give && this.inCensoringCountry()) {
    this._internalState.lastModal = MODAL.welcome;
    this.sync({'/modal': MODAL.giveModeForbidden});
    return;
  }
  this.sync({'/settings/mode': interaction});
  this._internalState.modalsCompleted[MODAL.welcome] = true;
  this._advanceModal();
};

ApiServlet._handlerForModal[MODAL.giveModeForbidden] = function(interaction, res) {
  if (interaction == INTERACTION.cancel || interaction == INTERACTION.continue) {
    if (interaction == INTERACTION.continue) {
      this.sync({'/settings/mode': MODE.get});
      this._internalState.modalsCompleted[MODAL.welcome] = true;
    }
    this._advanceModal(this._internalState.lastModal);
  } else {
    res.writeHead(400);
  }
};

ApiServlet._handlerForModal[MODAL.authorize] = function(interaction, res) {
  if (interaction != INTERACTION.continue) return res.writeHead(400);

  // check for gtalk authorization
  var scen = getByPath(this.model, '/mock/scenarios/applied/gtalkAuthorized');
  scen = getByPath(SCENARIOS, '/gtalkAuthorized/'+scen);
  if (!scen) {
    this._internalState.lastModal = MODAL.authorize;
    this.sync({'/modal': MODAL.scenarios,
      '/mock/scenarios/prompt': 'No oauth scenario applied.'});
    return;
  }
  log('applying gtalkAuthorized scenario', scen.desc);
  scen.func.call(this);
  if (!getByPath(this.model, '/connectivity/gtalkAuthorized')) {
    log('Google Talk access not granted, user must authorize');
    return;
  }

  // check for lantern access
  // XXX show this in UI?
  scen = getByPath(this.model, '/mock/scenarios/applied/invited');
  scen = getByPath(SCENARIOS, '/invited/'+scen);
  if (!scen) {
    this._internalState.lastModal = MODAL.authorize;
    this.sync({'/modal': MODAL.scenarios,
      '/mock/scenarios/prompt': 'No Lantern access scenario applied.'});
    return;
  }
  log('applying Lantern access scenario', scen.desc);
  scen.func.call(this);
  if (!getByPath(this.model, '/connectivity/invited')) {
    this.sync({'/modal': MODAL.notInvited});
    return;
  }

  // try connecting to google talk
  scen = getByPath(this.model, '/mock/scenarios/applied/gtalkReachable');
  scen = getByPath(SCENARIOS, '/gtalkReachable/'+scen);
  if (!scen) {
    this._internalState.lastModal = MODAL.authorize;
    this.sync({'/modal': MODAL.scenarios,
      '/mock/scenarios/prompt': 'No gtalkReachable scenario applied.'});
    return;
  }
  log('applying gtalkReachable scenario', scen.desc);
  scen.func.call(this);
  if (getByPath(this.model, '/connectivity/gtalk') != CONNECTIVITY.connected) {
    this.sync({'/modal': MODAL.gtalkUnreachable});
    return;
  }

  // fetch number of invites
  scen = getByPath(this.model, '/mock/scenarios/applied/ninvites');
  scen = getByPath(SCENARIOS, '/ninvites/'+scen);
  if (!scen) {
    this._internalState.lastModal = MODAL.authorize;
    this.sync({'/modal': MODAL.scenarios,
      '/mock/scenarios/prompt': 'No ninvites scenario applied.'});
    return;
  }
  log('applying ninvites scenario', scen.desc);
  scen.func.call(this);

  // fetch roster
  // XXX show this in UI?
  scen = getByPath(this.model, '/mock/scenarios/applied/roster');
  scen = getByPath(SCENARIOS, '/roster/'+scen);
  if (!scen) {
    this._internalState.lastModal = MODAL.authorize;
    this.sync({'/modal': MODAL.scenarios,
      '/mock/scenarios/prompt': 'No roster scenario applied.'});
    return;
  }
  log('applying roster scenario', scen.desc);
  scen.func.call(this);

  // fetch lantern friends
  scen = getByPath(this.model, '/mock/scenarios/applied/friends');
  scen = getByPath(SCENARIOS, '/friends/'+scen);
  if (!scen) {
    this._internalState.lastModal = MODAL.authorize;
    this.sync({'/modal': MODAL.scenarios,
      '/mock/scenarios/prompt': 'No friends scenario applied.'});
    return;
  }
  log('applying friends scenario', scen.desc);
  scen.func.call(this);

  // peer discovery and connection
  // XXX show this in UI?
  scen = getByPath(this.model, '/mock/scenarios/applied/peers');
  scen = getByPath(SCENARIOS, '/peers/'+scen);
  if (!scen) {
    this._internalState.lastModal = MODAL.authorize;
    this.updateModel({'/modal': MODAL.scenarios,
      '/mock/scenarios/prompt': 'No peers scenario applied.'});
    return;
  }
  log('applying peers scenario', scen.desc);
  scen.func.call(this);

  // country statistics
  scen = getByPath(this.model, '/mock/scenarios/applied/countries');
  scen = getByPath(SCENARIOS, '/countries/'+scen);
  if (!scen) {
    this._internalState.lastModal = MODAL.authorize;
    this.sync({'/modal': MODAL.scenarios,
      '/mock/scenarios/prompt': 'No countries scenario applied.'});
    return;
  }
  log('applying countries scenario', scen.desc);
  scen.func.call(this);

  this._internalState.modalsCompleted[MODAL.authorize] = true;
  this._advanceModal(this._internalState.lastModal);
};

ApiServlet._handlerForModal[MODAL.proxiedSites] = function(interaction, res, data) {
  if (interaction == INTERACTION.continue) {
    this._internalState.modalsCompleted[MODAL.proxiedSites] = true;
    this._advanceModal(this._internalState.lastModal);
  } else if (interaction == INTERACTION.set) {
    this.sync({'/settings/proxiedSites': data.value});
  } else if (interaction == INTERACTION.reset) {
    this.sync({'/settings/proxiedSites': this.DEFAULT_PROXIED_SITES});
  } else {
    res.writeHead(400);
  }
};

ApiServlet._handlerForModal[MODAL.systemProxy] = function(interaction, res, data) {
  if (interaction != INTERACTION.continue ||
      data.path != '/settings/systemProxy') {
    res.writeHead(400);
    return;
  }
  this.sync({'/settings/systemProxy': data.value});
  if (data.value) sleep.usleep(750000);
  this._internalState.modalsCompleted[MODAL.systemProxy] = true;
  this._advanceModal(this._internalState.lastModal);
};

ApiServlet._handlerForModal[MODAL.lanternFriends] = function(interaction, res, data) {
  if (interaction == INTERACTION.continue) {
    if (data && data.invite) {
      if (data.invite.length > this.model.ninvites) {
        log('more invitees than invites', data);
        return res.writeHead(400);
      }
      for (var i=0, ii=data.invite[i]; ii; ii=data.invite[++i]) {
        if (!EMAIL.test(ii)) {
          log('not a valid email:', ii);
          return res.writeHead(400);
        }
      }
      this.sync({'/ninvites': this.model.ninvites - data.invite.length});
      log('invitations will be sent to', data.invite);
      // XXX display notification in UI
    }
    this._internalState.modalsCompleted[MODAL.lanternFriends] = true;
    this._advanceModal(this._internalState.lastModal);
  } else if (interaction == INTERACTION.accept ||
             interaction == INTERACTION.decline) {
    var pending = getByPath(this.model, '/friends/pending', []),
        i = _.pluck(pending, 'email').indexOf(data.email);
    if (i == -1) return res.writeHead(400);
    var patch = [{op: 'remove', path: '/friends/pending/'+i}];
    if (interaction == INTERACTION.accept) {
      patch.push({op: 'add', value: data,
        path: '/friends/current/'+(this.model.friends.current.length-1)});
      patch.push({op: 'add', value: data,
        path: '/roster/'+(this.model.roster.length-1)});
    }
    this.sync(patch);
  } else {
    res.writeHead(400);
  }
};

ApiServlet._handlerForModal[MODAL.gtalkUnreachable] = function(interaction, res) {
  if (interaction == INTERACTION.retry) {
    this.sync({'/modal': MODAL.authorize});
  } else if (interaction == INTERACTION.retryLater) {
    this.sync({'/modal': MODAL.authorizeLater});
  } else {
    res.writeHead(400);
  }
};

ApiServlet._handlerForModal[MODAL.authorizeLater] = function(interaction, res) {
  if (interaction != INTERACTION.continue) {
    res.writeHead(400);
    return;
  }
  this.sync({'/modal': MODAL.none, showVis: true});
};

ApiServlet._handlerForModal[MODAL.notInvited] = function(interaction, res) {
  if (interaction == INTERACTION.retry) {
    this.sync({'/modal': MODAL.authorize});
  } else if (interaction == INTERACTION.requestInvite) {
    this.sync({'/modal': MODAL.requestInvite});
  } else {
    res.writeHead(400);
  }
};

ApiServlet._handlerForModal[MODAL.requestSent] = function(interaction, res) {
  if (interaction != INTERACTION.continue) return res.writeHead(400);
  this.sync({'/modal': MODAL.none, '/showVis': true});
};

ApiServlet._handlerForModal[MODAL.firstInviteReceived] = function(interaction, res) {
  if (interaction != INTERACTION.continue) return res.writeHead(400);
  this._advanceModal(this._internalState.lastModal);
};

ApiServlet._handlerForModal[MODAL.finished] = function(interaction, res, data) {
  if (interaction == INTERACTION.set && data &&
      data.path == '/settings/autoReport' && _.isBoolean(data.value)) {
    this.sync({'/settings/autoReport': data.value});
    return;
  }
  if (interaction != INTERACTION.continue) return res.writeHead(400);
  this._internalState.modalsCompleted[MODAL.finished] = true;
  this._advanceModal(this._internalState.lastModal);
  this.sync({'/setupComplete': true, '/showVis': true});
};

ApiServlet._handlerForModal[MODAL.settings] = function(interaction, res, data) {
  this._internalState.lastModal = MODAL.settings;
  if (interaction in MODE) {
    if (interaction == MODE.give && this.inCensoringCountry()) {
      this.sync({'/modal': MODAL.giveModeForbidden});
      res.writeHead(400);
      return;
    }
    var wasInGiveMode = this.inGiveMode();
    if (wasInGiveMode && this.model.settings.systemProxy)
      sleep.usleep(750000);
    this.sync({'/settings/mode': interaction});
    // switching from Give to Get for the first time shows unseen Get Mode modals
    this._advanceModal(MODAL.settings);
  } else if (interaction == INTERACTION.proxiedSites) {
    this.sync({'/modal': MODAL.proxiedSites});
  } else if (interaction == INTERACTION.close) {
    this.sync({'/modal': MODAL.none});
  } else if (interaction == INTERACTION.reset) {
    this.sync({'/modal': MODAL.confirmReset});
  } else if (interaction == INTERACTION.set) {
    var l = '/settings/'.length, setting = data.path.substring(l);
    if (data.path.substring(0, l) != '/settings/' || !(setting in SETTING)) return res.writeHead(400);
    this.sync(data); // XXX validate
  } else {
    res.writeHead(400);
  }
};

ApiServlet._handlerForModal[MODAL.confirmReset] = function(interaction, res) {
  if (interaction == INTERACTION.cancel) {
    this.sync({'/modal': this._internalState.lastModal});
  } else if (interaction == INTERACTION.reset) {
    SKIPSETUP = false;
    this.reset();
  } else {
    res.writeHead(400);
  }
};

ApiServlet.prototype.handleRequest = function(req, res) {
  var self = this, handled = false;
  log(req.url.href);
  // POST /api/<x.y.z>/interaction/<interactionid>
  if (req.method != 'POST') {
    res.writeHead(405);
  } else {
    var path = url.parse(req.url).pathname,
        parts = path.split('/'),
        mnt = parts[1],
        verstr = parts[2],
        ver = (verstr || '').split('.'),
        interaction = parts[3],
        interactionid = parts[4];
    if (mnt != ApiServlet.MOUNT_POINT ||
        ver[0] != ApiServlet.VERSION.major ||
        ver[1] != ApiServlet.VERSION.minor ||
        interaction != 'interaction' ||
        !(interactionid in INTERACTION)) {
      res.writeHead(404);
    } else {
      var data = '', error = false;
      req.addListener('data', function(chunk) { data += chunk; });
      req.addListener('end', function() {
        if (data) {
          try {
            data = JSON.parse(data);
            log('got data:', data);
          } catch (e) {
            log('Error parsing JSON:', e)
            res.writeHead(400);
            error = true;
          }
        }
        if (!error) {
          if (interactionid in ApiServlet._handlerForInteraction) {
            var handler = ApiServlet._handlerForInteraction[interactionid];
            if (handler)
              handler.call(self, res, data);
            else
              res.writeHead(404);
          } else {
            var handler = ApiServlet._handlerForModal[self.model.modal];
            if (handler)
              handler.call(self, interactionid, res, data);
            else
              res.writeHead(404);
          }
        }
        res.end();
        log(res.statusCode);
      });
      handled = true;
    }
  }
  if (!handled) {
    res.end();
    log(res.statusCode);
  }
};


exports.ApiServlet = ApiServlet;
