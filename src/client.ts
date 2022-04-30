import BN from "bn.js";
import { Address, Cell, parseAccount, RawCurrencyCollection } from "ton";
import { parseShardStateUnsplit } from "ton/dist/block/parse";
import { LiteEngine } from "./engines/engine";
import { parseShards } from "./parser/parseShards";
import { Functions, liteServer_blockHeader, liteServer_transactionId, liteServer_transactionId3, tonNode_blockIdExt } from "./schema";
import DataLoader from 'dataloader';
import { createBackoff } from "teslabot";

const ZERO = new BN(0);
const backoff = createBackoff({ onError: (e, i) => i > 3 && console.warn(e) });

//
// Ops
//

const lookupBlockByID = async (engine: LiteEngine, props: { seqno: number, shard: string, workchain: number }) => {
    return await engine.query(Functions.liteServer_lookupBlock, {
        kind: 'liteServer.lookupBlock',
        mode: 1,
        id: {
            kind: 'tonNode.blockId',
            seqno: props.seqno,
            shard: props.shard,
            workchain: props.workchain
        },
        lt: null,
        utime: null
    }, 5000);
}

type AllShardsResponse = {
    id: tonNode_blockIdExt;
    shards: {
        [key: string]: {
            [key: string]: number;
        };
    };
    raw: Buffer;
    proof: Buffer;
}
const getAllShardsInfo = async (engine: LiteEngine, props: { seqno: number, shard: string, workchain: number, rootHash: Buffer, fileHash: Buffer }) => {
    let res = (await engine.query(Functions.liteServer_getAllShardsInfo, { kind: 'liteServer.getAllShardsInfo', id: props }, 5000));
    let parsed = parseShards(Cell.fromBoc(res.data)[0].beginParse());
    let shards: { [key: string]: { [key: string]: number } } = {};
    for (let p of parsed) {
        shards[p[0]] = {};
        for (let p2 of p[1]) {
            shards[p[0]][p2[0]] = p2[1];
        }
    }
    return {
        id: res.id,
        shards,
        raw: res.data,
        proof: res.proof
    }
}

const getBlockHeader = async (engine: LiteEngine, props: { seqno: number, shard: string, workchain: number, rootHash: Buffer, fileHash: Buffer }) => {
    return await engine.query(Functions.liteServer_getBlockHeader, {
        kind: 'liteServer.getBlockHeader',
        mode: 1,
        id: {
            kind: 'tonNode.blockIdExt',
            seqno: props.seqno,
            shard: props.shard,
            workchain: props.workchain,
            rootHash: props.rootHash,
            fileHash: props.fileHash
        }
    }, 5000);
}

export class LiteClient {
    readonly engine: LiteEngine;
    #blockLockup: DataLoader<{ seqno: number, shard: string, workchain: number }, liteServer_blockHeader, string>;
    #shardsLockup: DataLoader<{ seqno: number, shard: string, workchain: number, rootHash: Buffer, fileHash: Buffer }, AllShardsResponse, string>;
    #blockHeader: DataLoader<{ seqno: number, shard: string, workchain: number, rootHash: Buffer, fileHash: Buffer }, liteServer_blockHeader, string>;

    constructor(opts: { engine: LiteEngine, batchSize?: number | undefined | null }) {
        this.engine = opts.engine;
        let batchSize = typeof opts.batchSize === 'number' ? opts.batchSize : 100;

        this.#blockLockup = new DataLoader(async (s) => {
            return await Promise.all(s.map((v) => lookupBlockByID(this.engine, v)));
        }, { maxBatchSize: batchSize, cacheKeyFn: (s) => s.workchain + '::' + s.shard + '::' + s.seqno });

        this.#blockHeader = new DataLoader(async (s) => {
            return await Promise.all(s.map((v) => getBlockHeader(this.engine, v)));
        }, { maxBatchSize: batchSize, cacheKeyFn: (s) => s.workchain + '::' + s.shard + '::' + s.seqno });

        this.#shardsLockup = new DataLoader<{ seqno: number, shard: string, workchain: number, rootHash: Buffer, fileHash: Buffer }, AllShardsResponse, string>(async (s) => {
            return await Promise.all(s.map((v) => getAllShardsInfo(this.engine, v)));
        }, { maxBatchSize: batchSize, cacheKeyFn: (s) => s.workchain + '::' + s.shard + '::' + s.seqno });
    }

    //
    // State
    //

    getMasterchainInfo = async () => {
        return this.engine.query(Functions.liteServer_getMasterchainInfo, { kind: 'liteServer.masterchainInfo' }, 5000);
    }

    getMasterchainInfoExt = async () => {
        return this.engine.query(Functions.liteServer_getMasterchainInfoExt, { kind: 'liteServer.masterchainInfoExt', mode: 0 }, 5000);
    }

    getCurrentTime = async () => {
        return (await this.engine.query(Functions.liteServer_getTime, { kind: 'liteServer.getTime' }, 5000)).now;
    }

    getVersion = async () => {
        return (await this.engine.query(Functions.liteServer_getVersion, { kind: 'liteServer.getVersion' }, 5000));
    }

    //
    // Account
    //

    getAccountState = async (src: Address, block: { seqno: number, shard: string, workchain: number, rootHash: Buffer, fileHash: Buffer }, timeout: number = 5000) => {
        let res = (await this.engine.query(Functions.liteServer_getAccountState, {
            kind: 'liteServer.getAccountState',
            id: {
                kind: 'tonNode.blockIdExt',
                seqno: block.seqno,
                shard: block.shard,
                workchain: block.workchain,
                fileHash: block.fileHash,
                rootHash: block.rootHash
            },
            account: {
                kind: 'liteServer.accountId',
                workchain: src.workChain,
                id: src.hash
            }
        }, timeout));

        let account = parseAccount(Cell.fromBoc(res.state)[0].beginParse())!;
        let balance: RawCurrencyCollection = { coins: ZERO };
        let lastTx: { lt: string, hash: Buffer } | null = null;
        if (account) {
            balance = account.storage.balance;
            let shardState = parseShardStateUnsplit(Cell.fromBoc(res.proof)[1].refs[0].beginParse());
            let hashId = new BN(src.hash.toString('hex'), 'hex').toString(10);
            let pstate = shardState.accounts.get(hashId);
            if (pstate) {
                lastTx = { hash: pstate.shardAccount.lastTransHash, lt: pstate.shardAccount.lastTransLt.toString(10) };
            }
        }

        return {
            state: account,
            lastTx,
            balance,
            raw: res.state,
            proof: res.proof,
            block: res.id,
            shardBlock: res.shardblk,
            shardProof: res.shardProof
        }
    }

    getAccountTransaction = async (src: Address, lt: string, block: { seqno: number, shard: string, workchain: number, rootHash: Buffer, fileHash: Buffer }) => {
        return await this.engine.query(Functions.liteServer_getOneTransaction, {
            kind: 'liteServer.getOneTransaction',
            id: block,
            account: {
                kind: 'liteServer.accountId',
                workchain: src.workChain,
                id: src.hash
            },
            lt: lt
        }, 5000);
    }

    getAccountTransactions = async (src: Address, lt: string, hash: Buffer) => {
        return await this.engine.query(Functions.liteServer_getTransactions, {
            kind: 'liteServer.getTransactions',
            count: 1,
            account: {
                kind: 'liteServer.accountId',
                workchain: src.workChain,
                id: src.hash
            },
            lt: lt,
            hash: hash
        }, 5000);
    }

    //
    // Block
    //

    lookupBlockByID = async (block: { seqno: number, shard: string, workchain: number }) => {
        return await this.#blockLockup.load(block);
    }

    getBlockHeader = async (block: { seqno: number, shard: string, workchain: number, rootHash: Buffer, fileHash: Buffer }) => {
        return this.#blockHeader.load(block);
    }

    getAllShardsInfo = async (block: { seqno: number, shard: string, workchain: number, rootHash: Buffer, fileHash: Buffer }) => {
        return this.#shardsLockup.load(block);
    }

    listBlockTransactions = async (block: { seqno: number, shard: string, workchain: number, rootHash: Buffer, fileHash: Buffer }, args?: {
        mode: number,
        count: number,
        after?: liteServer_transactionId3 | null | undefined,
        wantProof?: boolean
    }) => {

        let mode = args?.mode || 1 + 2 + 4;
        let count = args?.count || 100;
        let after: liteServer_transactionId3 | null = args && args.after ? args.after : null;

        return await this.engine.query(Functions.liteServer_listBlockTransactions, {
            kind: 'liteServer.listBlockTransactions',
            id: {
                kind: 'tonNode.blockIdExt',
                seqno: block.seqno,
                shard: block.shard,
                workchain: block.workchain,
                rootHash: block.rootHash,
                fileHash: block.fileHash
            },
            mode,
            count,
            reverseOrder: null,
            after,
            wantProof: null
        }, 5000);
    }

    getFullBlock = async (seqno: number) => {

        // MC Blocks
        let [mcBlockId, mcBlockPrevId] = await Promise.all([
            this.lookupBlockByID({ workchain: -1, shard: '-9223372036854775808', seqno: seqno }),
            this.lookupBlockByID({ workchain: -1, shard: '-9223372036854775808', seqno: seqno - 1 })
        ]);

        // Shards
        let [mcShards, mcShardsPrev] = await Promise.all([
            this.getAllShardsInfo(mcBlockId.id),
            this.getAllShardsInfo(mcBlockPrevId.id)
        ]);

        // Extract shards
        let shards: {
            workchain: number,
            seqno: number,
            shard: string
        }[] = [];
        shards.push({ seqno, workchain: -1, shard: '-9223372036854775808' });

        // Extract shards
        for (let wcs in mcShards.shards) {
            let wc = parseInt(wcs, 10);
            let psh = mcShardsPrev.shards[wcs] || {};

            for (let shs in mcShards.shards[wcs]) {
                let seqno = mcShards.shards[wcs][shs];
                let prevSeqno = psh[shs] || seqno;
                for (let s = prevSeqno + 1; s <= seqno; s++) {
                    shards.push({ seqno: s, workchain: wc, shard: shs });
                }
            }
        }

        // Fetch transactions and blocks
        let shards2 = await Promise.all(shards.map(async (shard) => {
            let blockId = await this.lookupBlockByID(shard);
            let transactions: liteServer_transactionId[] = [];
            let after: liteServer_transactionId3 | null = null;
            while (true) {
                let tr = await this.listBlockTransactions(blockId.id, { count: 50, mode: 1 + 2 + 4 });
                for (let t of tr.ids) {
                    transactions.push(t);
                }
                if (!tr.incomplete) {
                    break;
                }
                after = { kind: 'liteServer.transactionId3', account: tr.ids[tr.ids.length - 1].account!, lt: tr.ids[tr.ids.length - 1].lt! };
            }
            let mapped = transactions.map((t) => ({ hash: t.hash!, lt: t.lt!, account: t.account! }));

            return {
                ...shard,
                rootHash: blockId.id.rootHash,
                fileHash: blockId.id.fileHash,
                transactions: mapped
            }
        }));

        return {
            shards: shards2
        };
    }
}