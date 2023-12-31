import { GatewaySet as GatewaySetEvent, TxToL1 } from "../generated/L2GatewayRouter/L2GatewayRouter";
import { L2ToL1Transaction as ClassicL2ToL1TransactionEvent } from "../generated/ClassicArbSys/ClassicArbSys";
import { L2ToL1Tx as NitroL2ToL1TxEvent } from "../generated/NitroArbSys/NitroArbSys";
import { TicketCreated as NitroTicketCreatedEvent } from "../generated/NitroArbRetryableTx/NitroArbRetryableTx";
import { L2ArbitrumGateway } from "../generated/templates"
import { 
  WithdrawalInitiated as WithdrawalInitiatedEvent,
  DepositFinalized as DepositFinalizedEvent,
} from "../generated/templates/L2ArbitrumGateway/L2ArbitrumGateway"
import { Gateway, L2ToL1Transaction, Token, TokenGatewayJoinTable, GatewayWithdrawalData, L1ToL2Transaction, GatewayDepositData } from "../generated/schema";
import { Address, BigInt, ethereum, Bytes, log } from "@graphprotocol/graph-ts";
import { addressToId, bigIntToId, getJoinId, isNitro, L2_STD_GATEWAY } from "./util";
import { parseRetryableInput } from "./abi";


const processTokenGatewayPair = (
  l2Gateway: Address,
  l1Token: Address,
  block: ethereum.Block
): TokenGatewayJoinTable => {
  const gatewayId = addressToId(l2Gateway);
  const tokenId = addressToId(l1Token);
  const joinId = getJoinId(gatewayId, tokenId);

  let joinEntity = TokenGatewayJoinTable.load(joinId);
  // already created the entity
  if (joinEntity != null) return joinEntity;

  // the first deposit/withdrawal to an unrecognised pair is equivalent to a `GatewaySet` to handle the default gateway
  // if there is no gateway registered yet, then this was std bridged token since GatewaySet wasn't emitted first

  // TODO: should we always create instead of load? should be faster.
  // the issue here is if creating again on subsequent deposits. would that break FKs?
  let gatewayEntity = Gateway.load(gatewayId);
  
  if (gatewayEntity == null) {
    gatewayEntity = new Gateway(gatewayId);
    gatewayEntity.save();

    // the initial deposit/withdrawal will set the std gateway
    // but we don't want to create another listener
    // as these are only expected to be triggered on gateway set
    if(l2Gateway.notEqual(L2_STD_GATEWAY) ) {
      // we want to track every new arbitrum gateway
      // so we initialize a Data Source Template
      L2ArbitrumGateway.create(l2Gateway);
    }
  }

  let tokenEntity = Token.load(tokenId);
  if (tokenEntity == null) {
    tokenEntity = new Token(tokenId);
    tokenEntity.save();
  }

  joinEntity = new TokenGatewayJoinTable(joinId);
  joinEntity.gateway = gatewayId;
  joinEntity.token = tokenId;
  joinEntity.l2BlockNum = block.number;
  joinEntity.save();
  return joinEntity;
};

export function handleGatewaySet(event: GatewaySetEvent): void {
  // this event is not triggered for the default standard gateway, so we instead declare that bridge on the subgraph manifest separately

  if (event.params.gateway == Address.zero()) {
    // TODO: handle gateways being deleted
    return;
  }
  processTokenGatewayPair(event.params.gateway, event.params.l1Token, event.block)
}

export function handleWithdrawal(event: WithdrawalInitiatedEvent): void {
  // this event got emitted in the gateway itself
  const gatewayAddr = event.address;

  const join = processTokenGatewayPair(gatewayAddr, event.params.l1Token, event.block)

  const withdrawalId = bigIntToId(event.params._l2ToL1Id)
  const withdrawal = new GatewayWithdrawalData(withdrawalId)

  withdrawal.from = event.params._from
  withdrawal.to = event.params._to
  withdrawal.amount = event.params._amount
  withdrawal.exitNum = event.params._exitNum
  withdrawal.l2TxHash = event.transaction.hash
  withdrawal.l2BlockNum = event.block.number
  // disabled for consistency with deposit
  // withdrawal.l2ToL1Event = withdrawalId
  withdrawal.tokenGatewayJoin = join.id

  withdrawal.save()
}

export function handleDeposit(event: DepositFinalizedEvent): void {
  // this event got emitted in the gateway itself
  const gatewayAddr = event.address;

  const join = processTokenGatewayPair(gatewayAddr, event.params.l1Token, event.block)
  
  // tx hash here follows 
  const depositId = event.transaction.hash.toHexString()
  // TODO: can we use generics to CreateOrLoad and keep types?
  let deposit = GatewayDepositData.load(depositId)
  if(deposit == null) {
    deposit = new GatewayDepositData(depositId)
    deposit.from = event.params._from
    deposit.to = event.params._to
    deposit.amount = event.params._amount
    deposit.l2BlockNum = event.block.number
    deposit.l2TxHash = event.transaction.hash
  
    deposit.tokenGatewayJoin = join.id
    // TODO: can we correlate this without parsing all blocks
    // this is determined based on the retry attempt number and some other fields
    // deposit.l1ToL2Transaction = null
    deposit.save()
  } else {
    log.error("deposit event not expected to be emitted twice in tx: {}", [depositId.toString()])
  }
}


export function handleTicketCreated(event: NitroTicketCreatedEvent): void {
  if(isNitro(event.block)) handleNitroTicketCreated(event)
  else handleClassicTicketCreated(event)
}



// exported so it can be used in testing
export function handleNitroTicketCreated(event: NitroTicketCreatedEvent): void {  
    // this is set on the follow up RedeemScheduled
    // we don't currently have a good way of looking up if the tx was successful to correlate this event with a potential deposit event

    // this event is only emitted once per L1 to L2 ticket and only once in a tx
    const id = event.transaction.hash.toHexString()
    let entity = new L1ToL2Transaction(id)
  
    entity.isClassic = false
    entity.l1FromAliased = event.transaction.from

    const submitRetryableData = parseRetryableInput(event)
    entity.deposit = submitRetryableData.deposit
    entity.l2Callvalue = submitRetryableData.l2Callvalue
    entity.l2Calldata = submitRetryableData.l2Calldata
    entity.l2To = submitRetryableData.l2To
    entity.l2TxHash = event.transaction.hash
    entity.l2BlockNum = event.block.number

    entity.save()
}

// exported so it can be used in testing
export function handleClassicTicketCreated(event: NitroTicketCreatedEvent): void {
  // Nitro and Classic ticket creation events are backward compatible

  // this event is only emitted once per L1 to L2 ticket and only once in a tx
  const id = event.transaction.hash.toHexString()
  let entity = new L1ToL2Transaction(id)

  entity.isClassic = true
  entity.l1FromAliased = event.transaction.from
  
  entity.l2BlockNum = event.block.number
  entity.l2TxHash = event.transaction.hash

  const createRetrytableData = parseRetryableInput(event)
  
  entity.l2Callvalue = createRetrytableData.l2Callvalue
  entity.l2Calldata = createRetrytableData.l2Calldata
  entity.deposit = createRetrytableData.deposit
  entity.l2To = createRetrytableData.l2To
  
  entity.save();
}


export function handleNitroL2ToL1Transaction(event: NitroL2ToL1TxEvent): void {
  /**
   * the classic unique id was a counter in the precompile starting from 0
   * with nitro this instead became a hash of the leaf
   * then it got changed to be a counter again (position in merkle tree) starting from 0
   * 
   * here we assume classic id gets remapped to avoid a PK clash
   * we also assume the leaf hash doesn't clash with the counter
   */

  const id = bigIntToId(event.params.position)
  let entity = new L2ToL1Transaction(id);
  entity.l2From = event.params.caller;
  entity.l1To = event.params.destination;
  entity.batchNumber = null;
  entity.indexInBatch = event.params.position;
  entity.uniqueId = event.params.position;
  // entity.l2BlockNum = event.params.arbBlockNum;
  entity.l2BlockNum = event.block.number
  entity.l2TxHash = event.transaction.hash
  entity.l1BlockNum = event.params.ethBlockNum;
  entity.l2Timestamp = event.params.timestamp;
  entity.l1Callvalue = event.params.callvalue;
  entity.l1Calldata = event.params.data;
  entity.isClassic = false;
  entity.l2TxHash = event.transaction.hash;

  entity.save();
}

export function handleClassicL2ToL1Transaction(event: ClassicL2ToL1TransactionEvent): void {
  /**
   * the classic unique id was a counter in the precompile
   * with nitro this instead became a hash of the leaf id
   * then it got changed to be a counter again (position in merkle tree) starting from 0
   * 
   * the unique id deterministically generated from the uniqueId (sets the highest bit of the unique id as a uint64)
   * and allows us to correlate this event with the gateway's withdrawal event that uses the returned unique id
   *
   * this is equivalent to having a composite PK of `isClassic` and `uniqueId`, but subgraph schema doesn't allow us to do that
   */
  const mask = BigInt.fromI32(1).leftShift(63)
  const remappedId = mask.bitOr(event.params.uniqueId)
  const id = bigIntToId(remappedId)
  let entity = new L2ToL1Transaction(id);
  entity.l2From = event.params.caller;
  entity.l1To = event.params.destination;
  entity.batchNumber = event.params.batchNumber;
  entity.indexInBatch = event.params.indexInBatch;
  entity.uniqueId = event.params.uniqueId;
  // entity.l2BlockNum = event.params.arbBlockNum;
  entity.l2BlockNum = event.block.number
  entity.l2TxHash = event.transaction.hash
  entity.l1BlockNum = event.params.ethBlockNum;
  entity.l2Timestamp = event.params.timestamp;
  entity.l1Callvalue = event.params.callvalue;
  entity.l1Calldata = event.params.data;
  entity.isClassic = true;
  entity.l2TxHash = event.transaction.hash;

  entity.save();
}
