"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.readContract = void 0;
const contract_load_1 = require("./contract-load");
const utils_1 = require("./utils");
const contract_step_1 = require("./contract-step");
const errors_1 = __importDefault(require("./errors"));
const cache = {};
/**
 * Queries all interaction transactions and replays a contract to its latest state.
 *
 * If height is provided, will replay only to that block height.
 *
 * @param arweave         an Arweave client instance
 * @param contractId      the Transaction Id of the contract
 * @param height          if specified the contract will be replayed only to this block height
 * @param returnValidity  if true, the function will return valid and invalid transaction IDs along with the state
 */
function readContract(arweave, contractId, height, returnValidity) {
    var _a, _b;
    return __awaiter(this, void 0, void 0, function* () {
        if (!height) {
            const networkInfo = yield arweave.network.getInfo();
            height = networkInfo.height;
        }
        if (contractId in cache) {
            if (height in cache[contractId]) {
                const res = JSON.parse(cache[contractId][height]);
                return returnValidity ? { state: res.state, validity: res.validity } : res.state;
            }
        }
        const loadPromise = contract_load_1.loadContract(arweave, contractId).catch((err) => {
            const error = new errors_1.default("CONTRACT_NOT_FOUND" /* CONTRACT_NOT_FOUND */, {
                message: `Contract having txId: ${contractId} not found`,
                requestedTxId: contractId,
            });
            throw error;
        });
        const fetchTxPromise = fetchTransactions(arweave, contractId, height).catch((err) => err);
        let [contractInfo, txInfos] = yield Promise.all([loadPromise, fetchTxPromise]);
        if (contractInfo instanceof Error)
            throw contractInfo;
        if (txInfos instanceof Error)
            throw txInfos;
        let state;
        let contractSrc = contractInfo.contractSrc;
        try {
            state = JSON.parse(contractInfo.initState);
        }
        catch (e) {
            throw new Error(`Unable to parse initial state for contract: ${contractId}`);
        }
        utils_1.log(arweave, `Replaying ${txInfos.length} confirmed interactions`);
        txInfos.sort((a, b) => a.node.block.height - b.node.block.height || a.node.id.localeCompare(b.node.id));
        let { handler, swGlobal } = contractInfo;
        let validity = {};
        if (contractId in cache) {
            let max = 0;
            for (const item of Object.keys(cache[contractId])) {
                if (Number(item) > max && Number(item) < height)
                    max = Number(item);
            }
            txInfos = txInfos.filter((item) => item.node.block.height > max);
            const res = JSON.parse(cache[contractId][max]);
            state = res.state;
            validity = res.validity;
        }
        for (const txInfo of txInfos) {
            const currentTx = txInfo.node;
            const contractIndex = txInfo.node.tags.findIndex((tag) => tag.name === 'Contract' && tag.value === contractId);
            const inputTag = txInfo.node.tags[contractIndex + 1];
            if (!inputTag || inputTag.name !== 'Input') {
                utils_1.log(arweave, `Skipping tx with missing or invalid Input tag - ${currentTx.id}`);
                continue;
            }
            let input = inputTag.value;
            try {
                input = JSON.parse(input);
            }
            catch (e) {
                utils_1.log(arweave, e);
                continue;
            }
            if (!input) {
                utils_1.log(arweave, `Skipping tx with missing or invalid Input tag - ${currentTx.id}`);
                continue;
            }
            const interaction = {
                input,
                caller: currentTx.owner.address,
            };
            swGlobal._activeTx = currentTx;
            const result = yield contract_step_1.execute(handler, interaction, state);
            if (result.type === 'exception') {
                utils_1.log(arweave, `${result.result}`);
                utils_1.log(arweave, `Executing of interaction: ${currentTx.id} threw exception.`);
            }
            if (result.type === 'error') {
                utils_1.log(arweave, `${result.result}`);
                utils_1.log(arweave, `Executing of interaction: ${currentTx.id} returned error.`);
            }
            validity[currentTx.id] = result.type === 'ok';
            state = result.state;
            const evolve = state.evolve || ((_a = state.settings) === null || _a === void 0 ? void 0 : _a.evolve);
            if (evolve && /[a-z0-9_-]{43}/i.test(evolve) && (state.canEvolve || ((_b = state.settings) === null || _b === void 0 ? void 0 : _b.canEvolve))) {
                if (contractSrc !== state.evolve) {
                    try {
                        console.log('inside evolve!', state.evolve);
                        contractInfo = yield contract_load_1.loadContract(arweave, contractId, evolve);
                        handler = contractInfo.handler;
                    }
                    catch (e) {
                        const error = new errors_1.default("CONTRACT_NOT_FOUND" /* CONTRACT_NOT_FOUND */, {
                            message: `Contract having txId: ${contractId} not found`,
                            requestedTxId: contractId,
                        });
                        throw error;
                    }
                }
            }
        }
        cache[contractId] = Object.assign(Object.assign({}, (cache[contractId] || {})), { [height]: JSON.stringify({ state, validity }) });
        return returnValidity ? { state, validity } : state;
    });
}
exports.readContract = readContract;
// the maximum number of transactions we can get from graphql at once
const MAX_REQUEST = 100;
// fetch all contract interactions up to the specified block height
function fetchTransactions(arweave, contractId, height) {
    return __awaiter(this, void 0, void 0, function* () {
        let variables = {
            tags: [
                {
                    name: 'App-Name',
                    values: ['SmartWeaveAction'],
                },
                {
                    name: 'Contract',
                    values: [contractId],
                },
            ],
            blockFilter: {
                max: height,
            },
            first: MAX_REQUEST,
        };
        let transactions = yield getNextPage(arweave, variables);
        const txInfos = transactions.edges.filter((tx) => !tx.node.parent || !tx.node.parent.id);
        while (transactions.pageInfo.hasNextPage) {
            const cursor = transactions.edges[MAX_REQUEST - 1].cursor;
            variables = Object.assign(Object.assign({}, variables), { after: cursor });
            transactions = yield getNextPage(arweave, variables);
            txInfos.push(...transactions.edges.filter((tx) => !tx.node.parent || !tx.node.parent.id));
        }
        return txInfos;
    });
}
function getNextPage(arweave, variables) {
    return __awaiter(this, void 0, void 0, function* () {
        const query = `query Transactions($tags: [TagFilter!]!, $blockFilter: BlockFilter!, $first: Int!, $after: String) {
    transactions(tags: $tags, block: $blockFilter, first: $first, sort: HEIGHT_ASC, after: $after) {
      pageInfo {
        hasNextPage
      }
      edges {
        node {
          id
          owner { address }
          recipient
          tags {
            name
            value
          }
          block {
            height
            id
            timestamp
          }
          fee { winston }
          quantity { winston }
          parent { id }
        }
        cursor
      }
    }
  }`;
        const response = yield arweave.api.post('graphql', {
            query,
            variables,
        });
        if (response.status !== 200) {
            throw new Error(`Unable to retrieve transactions. Arweave gateway responded with status ${response.status}.`);
        }
        const data = response.data;
        const txs = data.data.transactions;
        return txs;
    });
}
