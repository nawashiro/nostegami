"use server";

import { verifyEvent } from "nostr-tools";
import { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";
import { getIp } from "@/src/getIp";
import { redis } from "@/src/redisUtil";
import { Ratelimit } from "@upstash/ratelimit";

const prisma = new PrismaClient();

interface SignedObject {
  outbox: string[];
  event: {
    kind: number;
    content: string;
    pubkey: string;
    created_at: number;
    tags: string[][];
    sig: string;
    id: string;
  };
}

//レートリミット
const ratelimit = new Ratelimit({
  redis: redis,
  limiter: Ratelimit.slidingWindow(6, "1 h"),
});

//バリデーション
const validation = (res: SignedObject) => {
  if (!verifyEvent(res.event)) throw new Error("不正なイベント");

  if (res.event.kind != 1) throw new Error("不正なkind");

  if (res.event.content.length > 1200)
    throw new Error("コンテンツが長すぎます");

  if (res.event.created_at * 1000 < new Date().getTime())
    throw new Error("過去が指定されています");

  if (
    res.event.tags.length != 1 ||
    res.event.tags[0].length != 2 ||
    res.event.tags[0][0] != "p"
  )
    throw new Error("不正なタグ");

  const createdAt = new Date(res.event.created_at * 1000);

  if (
    !(
      createdAt.getUTCHours() == 22 &&
      createdAt.getUTCMinutes() == 0 &&
      createdAt.getUTCSeconds() == 0 &&
      createdAt.getUTCMilliseconds() == 0
    )
  )
    throw new Error("時刻が不正です");

  const urlPattern = new RegExp(
    "^(wss?:\\/\\/)?" + // protocol
      "((([a-z\\d]([a-z\\d-]*[a-z\\d])*)\\.)+[a-z]{2,}|" + // domain name and extension
      "((\\d{1,3}\\.){3}\\d{1,3}))" + // OR ip (v4) address
      "(\\:\\d+)?(\\/[-a-z\\d%_.~+]*)*" + // port and path
      "(\\?[;&a-z\\d%_.~+=-]*)?" + // query string
      "(\\#[-a-z\\d_]*)?$",
    "i"
  ); // fragment locator

  for (const value of res.outbox) {
    if (!urlPattern.test(value)) {
      throw Error("WebSocketサーバーurlが不正です");
    }
  }
};

//インサート
const dbInsert = async (res: SignedObject, ip: string) => {
  const sendDay = new Date(res.event.created_at * 1000);

  sendDay.setUTCHours(0);
  sendDay.setUTCMinutes(0);
  sendDay.setUTCSeconds(0);
  sendDay.setUTCMilliseconds(0);

  await prisma.posts.create({
    data: { sendDay: sendDay, relays: res.outbox, event: res.event, ip: ip },
  });
};

//投函済みページ用データインサート
const submittedDataSet = async (res: SignedObject, ip: string) => {
  const id = `event-${res.event.id}`;
  await redis.hset(id, {
    sendAt: res.event.created_at,
    ip: ip,
    address: res.event.tags[0][1],
  });
  await redis.expire(id, 60 * 5);
};

export async function POST(req: NextRequest) {
  const ip = getIp(req);
  const res: SignedObject = await req.json();

  const successIp = (await ratelimit.limit(ip)).success;
  if (!successIp) {
    return new Response("Too many requests", { status: 429 });
  }

  try {
    validation(res);
  } catch (e) {
    console.log(e);
    return new Response("Unprocessable Entity", { status: 422 });
  }

  const successPubkey = (await ratelimit.limit(res.event.pubkey)).success;
  if (!successPubkey) {
    return new Response("Too many requests", { status: 429 });
  }

  try {
    await dbInsert(res, ip);
    await submittedDataSet(res, ip);
  } catch (e) {
    console.log(e);
    return new Response("Internal server error", { status: 500 });
  }

  return new Response("ok", { status: 200 });
}
