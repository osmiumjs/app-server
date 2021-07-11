const path = require('path');
const Session = require('./libs/session');
const {DB} = require('@osmium/db');
const {ClickHouse} = require('@osmium/clickhouse');
const {ApiTransportServer} = require('@osmium/api-transport');

const fs = require('mz/fs');
const moment = require('moment');

const {Events} = require('@osmium/events');
const nTools = require('@osmium/tools');
const IOServer = require('socket.io');
const {ServiceInterface} = require('./libs/serviceInterface');

const http = require('http');
const https = require('https');
const Express = require('express');
const bodyParser = require('body-parser');
const CookieParser = require('cookie-parser');
const Joi = require('@hapi/joi');
const R = require('ramda');

/**
 * @class {ApiServer & Events}
 */
class ApiServer extends Events {
	/** @type {Express} */
	express;

	/** @type {string} */
	projectPath;

	/** @type {import('@types/mz/fs')} **/
	fs;

	/** @type {import('ramda')} **/
	R;

	/** @type {import('@types/hapi__joi')} **/
	Joi;

	/** @type {import('@osmium/tools')} **/
	nTools;

	/** @type {DB} **/
	db;

	/** @type {import('@osmium/clickhouse').ClickHouse} **/
	ch;

	/** @type {ApiTransportServer} */
	server;

	/** @type {Server} */
	httpServer;

	events = {
		WEBSERVER_BEFORE_INIT  : 'WEBSERVER_BEFORE_INIT',
		WEBSERVER_BEFORE_CREATE: 'WEBSERVER_BEFORE_CREATE',
		WEBSERVER_AFTER_CREATE : 'WEBSERVER_AFTER_CREATE',
		DB_BEFORE_SCHEMA       : 'DB_BEFORE_SCHEMA',
		DB_BEFORE_SYNC         : 'DB_BEFORE_SYNC',
		DB_AFTER_SYNC          : 'DB_AFTER_SYNC',
		API_BEFORE_SERVER_START: 'API_BEFORE_SERVER_START',
		API_AFTER_SERVER_START : 'API_AFTER_SERVER_START',
		API_BEFORE_SI_START    : 'API_BEFORE_SI_START',
		API_AFTER_SI_START     : 'API_AFTER_SI_START',
		WEBSERVER_BEFORE_ROUTER: 'WEBSERVER_BEFORE_ROUTER',
		WEBSERVER_AFTER_ROUTER : 'WEBSERVER_AFTER_ROUTER',
		API_CALL_BEFORE        : 'API_CALL_BEFORE',
		API_CALL_AFTER         : 'API_CALL_AFTER',
		API_REGISTRED          : 'API_REGISTRED',
		API_BEFORE_LOAD        : 'API_BEFORE_LOAD',
		API_AFTER_LOAD         : 'API_AFTER_LOAD'
	};

	constructor(config) {
		super();

		process
			.on('unhandledRejection', (err) => this.toError(err))
			.on('uncaughtException', err => this.toError(err));

		this.projectPath = require.main.path;
		this.apisOptions = {};
		this.customRouter = false;

		this.fs = fs;
		this.R = R;
		this.Joi = Joi;
		this.nTools = nTools;

		this.config = config;
		this.Express = Express;

		this.express = this.Express();
		this.session = new Session(this.config.session);

		this.customAccess = {};
		this.models = false;
		this.passport = false;

		const conf = this.config.db;
		if (!conf) return this.db = false;

		/**
		 * @type {Sequelize.DB}
		 */
		this.db = new DB(conf.name, conf.user, conf.password, conf.host || 'localhost', conf.port || 5432, 'postgres', conf.logging || false, Object.assign({
			defPath: `${this.projectPath}/../defs`
		}, conf.options || {}));
	}

	toLog(...args) {
		console.log(`${moment().format('DD.MM.YY HH:mm:ss.SSS')} | <Server>`, ...args);
	}

	toError(...args) {
		console.error(`${moment().format('DD.MM.YY HH:mm:ss.SSS')} | <Server> Error:`, ...args);
	}

	async start(dbSchema) {
		await this.initWebServer();
		await this.initDB(dbSchema);
		await this.initCH();
		await this.startApiServer();
		await this.startSIServer();

		await this.session.use(this.express, this.ioServer, this.server);

		await this.processRoutes();
		await this.processApi();
		await this.startWebServer();
	}

	async initWebServer() {
		await this.emit(this.events.WEBSERVER_BEFORE_INIT);

		this.express.use(bodyParser.urlencoded({extended: false}));
		this.express.use(bodyParser.json());
		const cookieParser = CookieParser(this.config.session.secret);
		this.express.use((...args) => cookieParser(...args));

		this.express.set('trust proxy', 1);
		this.express.set('view engine', 'pug');
		this.express.set('views', './dist/views');

		this.express.use(Express.static('dist'));

		if (this.config.secure && this.config.secure.key && this.config.secure.cert) {
			this.config.cert = {
				key : await this.fs.readFile(this.config.secure.key),
				cert: await this.fs.readFile(this.config.secure.cert)
			};

			if (this.config.secure.dhparam) {
				this.config.cert.dhparam = await fs.readFile(this.config.secure.dhparam);
			}
		}

		await this.emit(this.events.WEBSERVER_BEFORE_CREATE);
		this.httpServer = this.config.secure && this.config.secure.httpsServer ? https.createServer(this.config.cert || {}, this.express) : http.createServer(this.express);
		await this.emit(this.events.WEBSERVER_AFTER_CREATE);
	}

	async initDB(dbSchema) {
		const conf = this.config.db;
		if (!conf) return this.db = false;

		await this.emit(this.events.DB_BEFORE_SCHEMA);
		await dbSchema(this.db, this);

		await this.emit(this.events.DB_BEFORE_SYNC);
		await this.db.sync();

		this.toLog('DB Synced');

		await this.db.makeDefs();
		await this.emit(this.events.DB_AFTER_SYNC);
	}

	async initCH() {
		const conf = this.config.clickHouse;
		if (!conf) this.ch = false;
		this.ch = new ClickHouse(conf);
	}

	async startApiServer() {
		this.ioServer = IOServer(this.httpServer, {
			serveClient: false,
			transports : ['websocket', 'polling']
		});

		await this.emit(this.events.API_BEFORE_SERVER_START);
		this.server = new ApiTransportServer(this.ioServer, {});
		await this.emit(this.events.API_AFTER_SERVER_START);
	}

	async startSIServer() {
		if (!this.config.serviceInterface) return this.ioSI = false;

		this.ioSI = IOServer(this.config.serviceInterface.port, {
			serveClient: false,
			transports : ['websocket']
		});

		await this.emit(this.events.API_BEFORE_SI_START);
		this.si = new ServiceInterface(this.ioSI, {}, this.server);
		await this.emit(this.events.API_AFTER_SI_START);
	}

	async render(res, viewName, params = {app: 'app'}) {
		const isProduction = this.config.env === 'production';

		res.render(viewName, {
			app          : params.app,
			isProduction,
			isDevelopment: !isProduction,
			...params
		});
	}

	useRouter(cb) {
		this.customRouter = cb;
	}

	async processRoutes() {

		if (this.customRouter) {
			await this.emit(this.events.WEBSERVER_BEFORE_ROUTER, true);
			this.customRouter();
			await this.emit(this.events.WEBSERVER_AFTER_ROUTER, true);
			return;
		}

		await this.emit(this.events.WEBSERVER_BEFORE_ROUTER, false);
		this.express.get('*', (req, res) => {
			res.sendFile(path.resolve(this.projectPath + '/../dist/index.html'));
		});
		await this.emit(this.events.WEBSERVER_AFTER_ROUTER, false);
	}

	async registerCustomAccess(name, fn) {
		this.customAccess[name] = fn;
	}

	async processApi() {
		const apiPath = path.resolve(this.projectPath, this.config.apiPath || 'api/');

		this.server.middlewareIncBefore(1992, async ($packet, $socket, $args, $name, $meta, $break, $session) => {
			await this.emit(this.events.API_CALL_BEFORE, $packet.injects, $packet);

			const apiOptions = Object.assign({
				authed : true,
				session: true
			}, this.apisOptions[$name] || {});

			if (nTools.isArray(apiOptions.schema) && apiOptions.schema.length) {
				const args = {};
				const schemaObj = nTools.iterate(apiOptions.schema, (schemaEl, idx, iter) => {
					const key = `arg_pos_${idx + 1}`;
					iter.key(key);
					args[key] = $args[idx];

					if (!Joi.isSchema(schemaEl)) throw '[API Validation error] Error in validation schema definition';
					return schemaEl;
				}, {});

				const schema = Joi.object(schemaObj).required();

				try {
					await schema.validateAsync(args, {stripUnknown: true});
				} catch (e) {
					let errors = [];
					nTools.iterate(e.details, (detail) => {
						const detailPathNameArr = detail.path[0].split('_');
						const detailPathName = (detailPathNameArr.length === 3 ? `#${detailPathNameArr[2]}` : detail.path[0]).trim();
						const hasValue = detail.context.value !== undefined;
						if (detail.message !== `"${detail.path[0]}" is required`) {
							errors.push(`[Arg ${detailPathName}${
								detail.context.label === detail.path[0] ? '' : ` <${detail.context.label}>`
							} ${detail.message.replace(`"${detail.path[0]}" `, '')}]${!hasValue ? '' : ':'}`);
						} else {
							errors.push(`[Arg ${detailPathName} is required]`);
						}
						if (hasValue) errors.push(detail.context.value);
					});

					throw {message: `[API Validation error]: API '${$name}' call (${$socket.id})`, errors};
				}
			}

			if (apiOptions.session) {
				if (!$session) {
					throw `[API Session]: Access denied for method '${$name}' from ${$socket.id}`;
				}
			}

			if (apiOptions.authed) {
				if (!$session || !$session.authed) {
					throw `[API Auth]: Access denied for method '${$name}' from ${$socket.id}`;
				}
			}

			if (apiOptions.access && apiOptions.authed) {
				if (!$session.user || !$session.user.access || !($session.user.access[apiOptions.access] || $session.user.access.all)) {
					throw `[API Access]: Access denied for method '${$name}' from ${$socket.id}, user: [${$session.user.id}] ${$session.user.user}`;
				}
			}

			await nTools.iterate(this.customAccess, async (row, idx) => {
				if (apiOptions[idx] && nTools.isFunction(this.customAccess[idx])) {
					await this.customAccess[idx](apiOptions[idx], $session, $packet, this);
				}
			});

			await this.emit(this.events.API_CALL_AFTER, apiOptions, $packet.injects, $packet);
		});

		return nTools.iterate(await this.fs.exists(apiPath) ? await this.fs.readdir(apiPath) : [], async (file) => {
			let fName = file.split('.');
			const name = fName.pop().toLowerCase() === 'js' ? fName : false;
			if (!name) return undefined;

			await this.emit(this.events.API_BEFORE_LOAD);

			let apiImplFn;
			try {
				apiImplFn = require(path.resolve(apiPath, `${file}`));
			} catch (e) {
				return this.toLog(`Error: Can't load API implementation file "${apiPath}/${file}"\n`, e);
			}

			const apiFn = (subName, options, cb) => {
				const hasOptions = !nTools.isFunction(options) && nTools.isObject(options);
				const hasCb = nTools.isFunction(hasOptions ? cb : options);
				const fullName = `${name} ${subName}`;
				if (!hasCb) throw new Error(`Api implementation '${fullName}' dont have callback`);

				if (hasOptions) {
					options.schema = options.schema || options.v || options.validate;
					this.apisOptions[fullName] = options;
				}

				this.emit(this.events.API_REGISTRED, fullName);

				return this.server.on(fullName, hasOptions ? cb : options);
			};

			//Run API endpoint function
			try {
				await apiImplFn(this, apiFn, Joi, this.db, this.db.models, name);
			} catch (e) {
				return this.toLog(`Error: Can't load implementation function in file "${apiPath}/${file}"\n`, e);
			}

			await this.emit(this.events.API_AFTER_LOAD);
			return name;
		}, []);
	}

	async startWebServer() {
		this.httpServer.listen(this.config.port, () => this.toLog(`Webserver started at ${this.config.port} in ${this.config.secure ? 'HTTPS' : 'HTTP'} mode`));
	}
}

module.exports = {ApiServer};
