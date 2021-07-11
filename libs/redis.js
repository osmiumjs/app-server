const RedisConn = require('ioredis');

class Redis {
	constructor(config) {
		const connStr = `redis://${config.password ? `:${config.password}@` : ''}${config.host || '127.0.0.1'}:${config.port || 6379}/${config.db || 0}`;
		this.redis = new RedisConn(connStr);
	}

	async set(key, value = {}, assign = false, expire = false) {
		if (assign) {
			let curr = await this.redis.get(key);
			value = Object.assign(curr ? JSON.parse(curr) || {} : {}, value);
		}

		const encoded = JSON.stringify(value);
		await (expire ? this.redis.setex(key, expire, encoded) : this.redis.set(key, encoded));

		return value;
	}

	async get(key) {
		const ret = await this.redis.get(key);
		return ret ? JSON.parse(ret) : {};
	}

	async del(...keyOrKeys) {
		return await this.redis.del(...keyOrKeys);
	}
}

module.exports = Redis;
