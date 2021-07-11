const {parseDomain, ParseResultType} = require('parse-domain');
const Redis = require('./redis');
const nTools = require('@osmium/tools');
const cookieParser = require('cookie-parser');
const cookie = require('cookie');
const moment = require('moment');

/**
 * @param {string} what
 */
function detectDomain(what) {
	const {type, hostname, icann, labels} = parseDomain(what);

	switch (type) {
		case ParseResultType.NotListed:
			return `${labels.slice(-2).join('.')}`;

		case ParseResultType.Listed:
			return `${icann.domain}.${icann.topLevelDomains.pop()}`;

		case ParseResultType.Reserved:
		case ParseResultType.Ip:
		case ParseResultType.Invalid:
			return hostname;
	}
}

module.exports = class Session {
	constructor(config) {
		this.config = Object.assign({
			name  : 'NSS_',
			secret: 'superSecret',
			expire: 60 * 60 * 24 * 30 * 3,
			maxAge: 60 * 60 * 24 * 30 * 3
		}, config);

		this.redis = new Redis(this.config.redis);
	}

	makeId() {
		return nTools.UID(this.config.name, 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
	}

	async request(sid) {
		if (!nTools.isString(sid)) return {};

		return await this.redis.get(sid);
	}

	async save(sid, data = {}) {
		if (!nTools.isString(sid)) return false;

		return this.redis.set(sid, data, true, this.config.expire);
	}

	async destroy(sid) {
		if (!nTools.isString(sid)) return false;

		await this.redis.del(sid);
		return true;
	}

	async getSessionData(id, data = false) {
		data = data || await this.request(id);

		return Object.assign(data, {
			$save   : async () => await this.save(id, data),
			$destroy: async () => await this.destroy(id),
			$update : async () => data = await this.getSessionData(id),
			$id     : () => id
		});

	}

	async use(httpServer, ioServer, apiTransportServer) {
		const {name, secret, maxAge} = this.config;

		httpServer.use(async (req, res, next) => {
			const domain = this.config.domain || detectDomain(req.hostname);

			const id = req.signedCookies[name] || this.makeId();
			req.signedCookies[name] = req.sessionId = id;

			res.cookie(name, id, {
				signed : true,
				expires: moment().utc().add(maxAge, 's').toDate(),
				domain
			});

			const cookies = req.headers.cookie;
			req.cookies = {};
			req.signedCookies = {};

			const secrets = !secret || Array.isArray(secret) ? (secret || []) : [secret];
			req.secret = secrets[0];

			req.cookies = cookie.parse(cookies || '');

			if (secrets.length !== 0) {
				req.signedCookies = cookieParser.signedCookies(req.cookies, secrets);
				req.signedCookies = cookieParser.JSONCookies(req.signedCookies);
			}

			req.cookies = cookieParser.JSONCookies(req.cookies);

			const result = await this.save(req.sessionId);
			req.session = await this.getSessionData(req.sessionId, result);

			next();
		});

		ioServer.use(async (socket, next) => {
			const id = cookieParser.signedCookie(cookie.parse(socket.handshake.headers.cookie || '')[name], secret);
			if (!id) return socket.disconnect(true);

			socket.handshake.sessionId = id;
			next();
		});

		apiTransportServer.middlewareIncBefore(50, async ($name, $add, $socket) => {
			$add('sessionId', $socket.handshake.sessionId || false);
			$add('userAgent', $socket.request.headers['user-agent'] || false);
			$add('userIp', $socket.request.headers['x-real-ip'] || $socket.handshake.address || false);

			if (!$socket.handshake.sessionId) return;

			const sessionData = await this.getSessionData($socket.handshake.sessionId);
			$add('session', sessionData);
			$add('userId', sessionData.user ? sessionData.user.id : false);
		});
	}
};
