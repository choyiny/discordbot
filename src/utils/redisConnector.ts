import RedisSMQ from "rsmq";
import {environment} from "../config/environment";
import redis from 'redis';
import {ParsedMessage} from "discord-command-parser";
import {getLogger} from "./logger";
import axios, {AxiosRequestConfig} from "axios";

export interface RedisCommand {
  command: string
  arguments: string[]
  data: {
    guild_id: string
    message_id: string
    channel_id: string
    user_id: string
    content: string
    channel_type: string
  }
}

const logger = getLogger('redis');

export class RedisConnector {
  private static _instance: RedisConnector;
  rsmq: RedisSMQ;
  qname = "DISCORDJOBS";
  subscription: redis.RedisClient;
  client: redis.RedisClient;
  ns = "rsmq";

  constructor() {
    if (RedisConnector._instance) return;
    logger.info("Connecting redis...");
    this.subscription = redis.createClient({host: environment.redis.host,});
    this.client = redis.createClient({host: environment.redis.host,});

    this.subscription.on('connect', () => {
      logger.info("Redis is connected");
    });
    this.subscription.on('reconnecting', () => {
      logger.info("Redis is reconnecting");
    });

    this.subscription.subscribe(`${this.ns}:rt:${this.qname}`);
    this.rsmq = new RedisSMQ({
      host: environment.redis.host,
      port: environment.redis.port,
      ns: this.ns,
      realtime: true,
    });

    this.rsmq.listQueuesAsync()
      .then(q => {
        if (!q.includes(this.qname)) {
          logger.info("Creating queues");
          this.rsmq.createQueue({qname: "DISCORDJOBS"}, function (err, resp) {
            if (err) return logger.error(err);
            if (resp) return logger.info("Created redis queue");
          });
        } else {
          logger.info("Redis queues exist, skipping create");
        }
      })
      .catch(logger.error);
    RedisConnector._instance = this;
  }

  // this should only be used for request that serves static data
  cachedRequest<T>(req: AxiosRequestConfig): Promise<T> {
    return new Promise((resolve, reject) => {
      this.client.get(req.url, ((err, reply) => {
        if (err) return reject(err);
        // cache hit end here and return
        if (reply != null) {
          logger.debug(`Getting ${req.url} from cache`);
          return resolve(JSON.parse(reply) as T);
        }

        // cache miss, make the request and save the response iff status code is 200
        logger.debug(`Getting ${req.url} from remote`);
        axios.request<T>(req)
          .then(res => {
            if (res.status === 200) this.client.set(req.url, JSON.stringify(res.data), err1 => err1 ? reject(err1) : "");
            resolve(res.data);
          })
          .catch(err => {
            logger.debug(`Getting ${req.url} failed with ${err}`);
            reject(err);
          });
      }));
    });
  }

  static getInstance(): RedisConnector {
    return RedisConnector._instance || new RedisConnector();
  }

  sendCommand(pm: ParsedMessage): Promise<string> {
    let m = pm.message;
    let toSend: RedisCommand = {
      command: pm.command,
      arguments: pm.arguments,
      data: {
        guild_id: m.guild.id,
        message_id: m.id,
        channel_id: m.channel.id,
        user_id: m.author.id,
        content: m.content,
        channel_type: m.channel.type
      }
    };
    let p = this.rsmq.sendMessageAsync({qname: this.qname, message: JSON.stringify(toSend)});
    p.then(() => logger.debug("Sending " + JSON.stringify(toSend)));
    p.catch(logger.error);
    return p;
  }

  set(key: string, val: any): Promise<any> {
    return new Promise((resolve, reject) => {
      this.client.set(key, JSON.stringify(val), (err, res) => {
        if (err) return reject(err);
        resolve(res);
      });
    });
  }

  get(key: string): Promise<string> {
    return new Promise((resolve, reject) => {
      this.client.get(key, (err, res) => {
        if (err) return reject(err);
        return resolve(res);
      });
    });
  }
}