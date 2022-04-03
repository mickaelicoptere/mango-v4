import { Provider, Wallet, web3 } from '@project-serum/anchor';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import * as spl from '@solana/spl-token';
import fs from 'fs';
import { MangoClient } from './client';
import { findOrCreate } from './utils';
import {
  Bank,
  getBank,
  getBankForGroupAndMint,
  registerToken,
} from './accounts/types/bank';
import {
  createMangoAccount,
  deposit,
  getMangoAccount,
  getMangoAccountsForGroupAndOwner,
  MangoAccount,
  withdraw,
} from './accounts/types/mangoAccount';
import { createGroup, getGroupForAdmin, Group } from './accounts/types/group';
import {
  getSerum3MarketForBaseAndQuote,
  serum3CreateOpenOrders,
  Serum3Market,
  serum3RegisterMarket,
} from './accounts/types/serum3';
import {
  createStubOracle,
  getStubOracleForGroupAndMint,
} from './accounts/types/oracle';

async function main() {
  //
  // Setup
  //
  const options = Provider.defaultOptions();
  const connection = new Connection(
    'https://mango.devnet.rpcpool.com',
    options,
  );

  const admin = Keypair.fromSecretKey(
    Buffer.from(
      JSON.parse(fs.readFileSync(process.env.ADMIN_KEYPAIR!, 'utf-8')),
    ),
  );
  const adminWallet = new Wallet(admin);
  console.log(`Admin ${adminWallet.publicKey.toBase58()}`);
  const adminProvider = new Provider(connection, adminWallet, options);
  const adminClient = await MangoClient.connect(adminProvider, true);

  const payer = Keypair.fromSecretKey(
    Buffer.from(
      JSON.parse(fs.readFileSync(process.env.PAYER_KEYPAIR!, 'utf-8')),
    ),
  );
  console.log(`Payer ${payer.publicKey.toBase58()}`);
  //
  // Find existing or create a new group
  //
  const group: Group = await findOrCreate(
    'group',
    getGroupForAdmin,
    [adminClient, admin.publicKey],
    createGroup,
    [adminClient, admin.publicKey, payer],
  );
  console.log(`Group ${group.publicKey}`);

  //
  // Find existing or register new oracles
  //
  const usdcDevnetMint = new PublicKey(
    '8FRFC6MoGGkMFQwngccyu69VnYbzykGeez7ignHVAFSN',
  );
  const usdcDevnetStubOracle = await findOrCreate(
    'stubOracle',
    getStubOracleForGroupAndMint,
    [adminClient, group.publicKey, usdcDevnetMint],
    createStubOracle,
    [adminClient, group.publicKey, admin.publicKey, usdcDevnetMint, payer, 1],
  );
  const btcDevnetMint = new PublicKey(
    '3UNBZ6o52WTWwjac2kPUb4FyodhU1vFkRJheu1Sh2TvU',
  );
  const btcDevnetOracle = new PublicKey(
    'HovQMDrbAgAYPCmHVSrezcSmkMtXSSUsLDFANExrZh2J',
  );

  //
  // Find existing or register new tokens
  //
  // TODO: replace with 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU,
  // see https://developers.circle.com/docs/usdc-on-testnet#usdc-on-solana-testnet
  const btcBank = await findOrCreate<Bank>(
    'bank',
    getBankForGroupAndMint,
    [adminClient, group.publicKey, btcDevnetMint],
    registerToken,
    [
      adminClient,
      group.publicKey,
      admin.publicKey,
      btcDevnetMint,
      btcDevnetOracle,
      payer,
      0,
    ],
  );
  console.log(`BtcBank ${btcBank.publicKey}`);
  const usdcBank = await findOrCreate<Bank>(
    'bank',
    getBankForGroupAndMint,
    [adminClient, group.publicKey, usdcDevnetMint],
    registerToken,
    [
      adminClient,
      group.publicKey,
      admin.publicKey,
      usdcDevnetMint,
      usdcDevnetStubOracle,
      payer,
      0,
    ],
  );
  console.log(`UsdcBank ${usdcBank.publicKey}`);

  //
  // User operations
  //

  const user = Keypair.fromSecretKey(
    Buffer.from(
      JSON.parse(fs.readFileSync(process.env.USER_KEYPAIR!, 'utf-8')),
    ),
  );
  const userWallet = new Wallet(user);
  const userProvider = new Provider(connection, userWallet, options);
  const userClient = await MangoClient.connect(userProvider, true);
  console.log(`User ${userWallet.publicKey.toBase58()}`);

  //
  // Create mango account
  //
  const mangoAccount = await findOrCreate<MangoAccount>(
    'mangoAccount',
    getMangoAccountsForGroupAndOwner,
    [userClient, group.publicKey, user.publicKey],
    createMangoAccount,
    [userClient, group.publicKey, user.publicKey, payer],
  );
  console.log(`MangoAccount ${mangoAccount.publicKey}`);

  // deposit
  console.log(`Depositing...1000`);
  const btcTokenAccount = await spl.getAssociatedTokenAddress(
    btcDevnetMint,
    user.publicKey,
  );
  await deposit(
    userClient,
    group.publicKey,
    mangoAccount.publicKey,
    btcBank.publicKey,
    btcBank.vault,
    btcTokenAccount,
    btcDevnetOracle,
    user.publicKey,
    1000,
  );

  // withdraw
  console.log(`Witdrawing...500`);
  await withdraw(
    userClient,
    group.publicKey,
    mangoAccount.publicKey,
    btcBank.publicKey,
    btcBank.vault,
    btcTokenAccount,
    btcDevnetOracle,
    user.publicKey,
    500,
    false,
  );

  // log
  const freshBank = await getBank(userClient, btcBank.publicKey);
  console.log(freshBank.toString());

  const freshAccount = await getMangoAccount(
    userClient,
    mangoAccount.publicKey,
  );
  console.log(
    `Mango account  ${freshAccount.getNativeDeposit(
      freshBank,
    )} Deposits for bank ${freshBank.tokenIndex}`,
  );

  // close mango account, note: close doesnt settle/withdraw for user atm,
  // only use when you want to free up a mango account address for testing on not-mainnet
  // await closeMangoAccount(userClient, account.publicKey, user.publicKey);
  // accounts = await getMangoAccountsForGroupAndOwner(
  //   userClient,
  //   group.publicKey,
  //   user.publicKey,
  // );
  // if (accounts.length === 0) {
  //   console.log(`Closed account ${account.publicKey}`);
  // }

  //
  // Find existing or register a new serum3 market
  //
  const serumProgramId = new web3.PublicKey(
    'DESVgJVGajEgKGXhb6XmqDHGz3VjdgP7rEVESBgxmroY',
  );
  const serumMarketExternalPk = new web3.PublicKey(
    'DW83EpHFywBxCHmyARxwj3nzxJd7MUdSeznmrdzZKNZB',
  );
  const serum3Market = await findOrCreate<Serum3Market>(
    'serum3Market',
    getSerum3MarketForBaseAndQuote,
    [adminClient, group.publicKey, btcBank.tokenIndex, usdcBank.tokenIndex],
    serum3RegisterMarket,
    [
      adminClient,
      group.publicKey,
      admin.publicKey,
      serumProgramId,
      serumMarketExternalPk,
      usdcBank.publicKey,
      btcBank.publicKey,
      payer,
      0,
    ],
  );
  console.log(`Serum3Market ${serum3Market.publicKey}`);

  //
  // Place serum3 order
  //
  console.log('Creating serum3 open orders account...');
  await serum3CreateOpenOrders(
    userClient,
    group.publicKey,
    mangoAccount.publicKey,
    serum3Market.publicKey,
    serumProgramId,
    serumMarketExternalPk,
    user.publicKey,
    payer,
  );

  process.exit(0);
}

main();
