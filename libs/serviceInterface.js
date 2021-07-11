const {ApiTransportServer} = require('@osmium/api-transport');

/** @typedef {import('socket.io').SocketIO} SocketIO */

class ServiceInterface extends ApiTransportServer {
	/**
	 *
	 * @param {SocketIO} io
	 * @param {Object} options
	 * @param {ApiTransportServer} apiServer
	 */
	constructor(io, options, apiServer) {
		super(io, options);

		this.events = {
			API_CALL_BEFORE    : 'API_CALL_BEFORE',
			API_CALL_AFTER     : 'API_CALL_AFTER',
			API_OUT_CALL_BEFORE: 'API_OUT_CALL_BEFORE',
			API_OUT_CALL_AFTER : 'API_OUT_CALL_AFTER',
		};

		this.apiServer = apiServer;

		this.registerAPIServerMw();
	}

	registerAPIServerMw() {
		if (!this.apiServer) return;

		this.apiServer.middlewareIncBefore(1900, ($name) => {
			this.emit(this.events.API_CALL_BEFORE, true, $name);
		});

		this.apiServer.middlewareIncAfter(1900, ($name) => {
			this.emit(this.events.API_CALL_AFTER, true, $name);
		});

		this.apiServer.middlewareOutBefore(1900, ($name) => {
			this.emit(this.events.API_OUT_CALL_BEFORE, true, $name);
		});

		this.apiServer.middlewareOutAfter(1900, ($name) => {
			this.emit(this.events.API_OUT_CALL_AFTER, true, $name);
		});
	}
}

module.exports = {ServiceInterface};
