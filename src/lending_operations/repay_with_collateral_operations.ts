import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { KaminoAction, KaminoMarket, KaminoObligation, numberToLamportsDecimal } from '../classes';
import { SwapInputs, SwapIxnsProvider, getFlashLoanInstructions, toJson } from '../leverage';
import {
  PublicKeySet,
  U64_MAX,
  getAtasWithCreateIxnsIfMissing,
  getComputeBudgetAndPriorityFeeIxns,
  removeBudgetAndAtaIxns,
} from '../utils';
import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import Decimal from 'decimal.js';

export const repayWithCollCalcs = (props: {
  repayAmount: Decimal;
  priceDebtToColl: Decimal;
  slippagePct: Decimal;
  flashLoanFeePct: Decimal;
}): {
  repayAmount: Decimal;
  collToSwapIn: Decimal;
  swapDebtExpectedOut: Decimal;
} => {
  // Initialize local variables from the props object
  const { repayAmount, priceDebtToColl, slippagePct, flashLoanFeePct } = props;

  const slippage = slippagePct.div('100');
  const flashLoanFee = flashLoanFeePct.div('100');

  const swapDebtExpectedOut = repayAmount.mul(new Decimal(1.0).add(flashLoanFee));
  const collToSwapIn = swapDebtExpectedOut.mul(new Decimal(1.0).add(slippage)).mul(priceDebtToColl);

  return {
    repayAmount,
    collToSwapIn,
    swapDebtExpectedOut,
  };
};

export type InitialInputs = {
  repayAmount: Decimal;
  priceDebtToColl: Decimal;
  slippagePct: Decimal;
  currentSlot: number;
};

export const getRepayWithCollSwapInputs = (props: {
  repayAmount: Decimal;
  priceDebtToColl: Decimal;
  slippagePct: Decimal;
  kaminoMarket: KaminoMarket;
  debtTokenMint: PublicKey;
  collTokenMint: PublicKey;
  obligation: KaminoObligation;
  currentSlot: number;
}): {
  swapInputs: SwapInputs;
  initialInputs: InitialInputs;
} => {
  const {
    repayAmount,
    priceDebtToColl,
    slippagePct,
    kaminoMarket,
    debtTokenMint,
    collTokenMint,
    obligation,
    currentSlot,
  } = props;
  const collReserve = kaminoMarket.getReserveByMint(collTokenMint);
  const debtReserve = kaminoMarket.getReserveByMint(debtTokenMint);
  const flashLoanFeePct = debtReserve?.getFlashLoanFee().ceil() || new Decimal(0);

  const irSlippageBpsForDebt = obligation!
    .estimateObligationInterestRate(
      debtReserve!,
      obligation?.state.borrows.find((borrow) => borrow.borrowReserve?.equals(debtReserve!.address))!,
      currentSlot
    )
    .toDecimalPlaces(debtReserve?.state.liquidity.mintDecimals.toNumber()!, Decimal.ROUND_CEIL);
  // add 0.1% to irSlippageBpsForDebt because we don't want to estimate slightly less than SC and end up not repaying enough
  const repayAmountIrAdjusted = repayAmount
    .mul(irSlippageBpsForDebt.mul(new Decimal('1.001')))
    .toDecimalPlaces(debtReserve?.state.liquidity.mintDecimals.toNumber()!, Decimal.ROUND_CEIL);

  const repayCalcs = repayWithCollCalcs({
    repayAmount: repayAmountIrAdjusted,
    priceDebtToColl,
    slippagePct,
    flashLoanFeePct: flashLoanFeePct,
  });

  return {
    swapInputs: {
      inputAmountLamports: numberToLamportsDecimal(repayCalcs.collToSwapIn, collReserve!.stats.decimals)
        .ceil()
        .toNumber(),
      inputMint: collTokenMint,
      outputMint: debtTokenMint,
    },
    initialInputs: {
      repayAmount,
      priceDebtToColl,
      slippagePct,
      currentSlot,
    },
  };
};

export const getRepayWithCollIxns = async (props: {
  kaminoMarket: KaminoMarket;
  budgetAndPriorityFeeIxns: TransactionInstruction[];
  amount: Decimal;
  debtTokenMint: PublicKey;
  collTokenMint: PublicKey;
  owner: PublicKey;
  priceDebtToColl: Decimal;
  slippagePct: Decimal;
  isClosingPosition: boolean;
  obligation: KaminoObligation;
  referrer: PublicKey;
  swapper: SwapIxnsProvider;
  currentSlot: number;
  getTotalKlendAccountsOnly: boolean;
}): Promise<{
  ixns: TransactionInstruction[];
  lookupTablesAddresses: PublicKey[];
  swapInputs: SwapInputs;
  totalKlendAccounts: number;
  initialInputs: InitialInputs;
}> => {
  const {
    kaminoMarket,
    budgetAndPriorityFeeIxns,
    amount,
    debtTokenMint,
    collTokenMint,
    owner,
    priceDebtToColl,
    slippagePct,
    isClosingPosition,
    obligation,
    referrer,
    swapper,
    currentSlot,
    getTotalKlendAccountsOnly,
  } = props;

  const connection = kaminoMarket.getConnection();
  const collReserve = kaminoMarket.getReserveByMint(collTokenMint);
  const debtReserve = kaminoMarket.getReserveByMint(debtTokenMint);
  // const solTokenReserve = kaminoMarket.getReserveByMint(WRAPPED_SOL_MINT);
  const flashLoanFeePct = debtReserve?.getFlashLoanFee() || new Decimal(0);

  const irSlippageBpsForDebt = obligation!
    .estimateObligationInterestRate(
      debtReserve!,
      obligation?.state.borrows.find((borrow) => borrow.borrowReserve?.equals(debtReserve!.address))!,
      currentSlot
    )
    .toDecimalPlaces(debtReserve?.state.liquidity.mintDecimals.toNumber()!, Decimal.ROUND_CEIL);
  // add 0.1% to irSlippageBpsForDebt because we don't want to estimate slightly less than SC and end up not reapying enough
  const repayAmount = amount
    .mul(irSlippageBpsForDebt.mul(new Decimal('1.001')))
    .toDecimalPlaces(debtReserve?.state.liquidity.mintDecimals.toNumber()!, Decimal.ROUND_CEIL);

  const calcs = repayWithCollCalcs({
    repayAmount,
    priceDebtToColl,
    slippagePct,
    flashLoanFeePct,
  });

  console.log('Ops Calcs', toJson(calcs));

  // // 1. Create atas & budget txns
  const mintsToCreateAtas = [collTokenMint, debtTokenMint, collReserve!.getCTokenMint()];
  const mintsToCreateAtasTokenPrograms = [
    collReserve?.getLiquidityTokenProgram()!,
    debtReserve?.getLiquidityTokenProgram()!,
    TOKEN_PROGRAM_ID,
  ];

  const budgetIxns = budgetAndPriorityFeeIxns || getComputeBudgetAndPriorityFeeIxns(3000000);
  const {
    atas: [, debtTokenAta],
    createAtasIxns,
    closeAtasIxns,
  } = await getAtasWithCreateIxnsIfMissing(connection, owner, mintsToCreateAtas, mintsToCreateAtasTokenPrograms);

  // 1. Flash borrow & repay the debt to repay amount needed
  const { flashBorrowIxn, flashRepayIxn } = getFlashLoanInstructions({
    borrowIxnIndex: budgetIxns.length + createAtasIxns.length,
    walletPublicKey: owner,
    lendingMarketAuthority: kaminoMarket.getLendingMarketAuthority(),
    lendingMarketAddress: kaminoMarket.getAddress(),
    reserve: debtReserve!,
    amountLamports: numberToLamportsDecimal(repayAmount, debtReserve!.stats.decimals).floor(),
    destinationAta: debtTokenAta,
    referrerAccount: kaminoMarket.programId,
    referrerTokenState: kaminoMarket.programId,
    programId: kaminoMarket.programId,
  });

  // 2. Repay using the flash borrowed funds & withdraw collateral to swap and pay the flash loan
  const repayAndWithdrawAction = await KaminoAction.buildRepayAndWithdrawTxns(
    kaminoMarket,
    isClosingPosition ? U64_MAX : numberToLamportsDecimal(repayAmount, debtReserve!.stats.decimals).floor().toString(),
    new PublicKey(debtTokenMint),
    isClosingPosition
      ? U64_MAX
      : numberToLamportsDecimal(calcs.collToSwapIn, collReserve!.stats.decimals).ceil().toString(),
    new PublicKey(collTokenMint),
    owner,
    currentSlot,
    obligation,
    0,
    0,
    false,
    undefined,
    undefined,
    isClosingPosition,
    referrer
  );

  const ixns = [
    ...budgetIxns,
    ...createAtasIxns,
    ...[flashBorrowIxn],
    ...repayAndWithdrawAction.setupIxs,
    ...[repayAndWithdrawAction.lendingIxs[0]],
    ...repayAndWithdrawAction.inBetweenIxs,
    ...[repayAndWithdrawAction.lendingIxs[1]],
    ...repayAndWithdrawAction.cleanupIxs,
    ...[flashRepayIxn],
    ...closeAtasIxns,
  ];

  const uniqueAccounts = new PublicKeySet<PublicKey>([]);
  ixns.forEach((ixn) => {
    ixn.keys.forEach((key) => {
      uniqueAccounts.add(key.pubkey);
    });
  });
  const totalKlendAccounts = uniqueAccounts.toArray().length;

  // return early to avoid extra swapper calls
  if (getTotalKlendAccountsOnly) {
    return {
      ixns: [],
      lookupTablesAddresses: [],
      swapInputs: { inputAmountLamports: 0, inputMint: PublicKey.default, outputMint: PublicKey.default },
      totalKlendAccounts: totalKlendAccounts,
      initialInputs: {
        repayAmount,
        priceDebtToColl,
        slippagePct,
        currentSlot,
      },
    };
  }

  console.log(
    'Expected to swap in',
    calcs.collToSwapIn.toString(),
    'coll for',
    calcs.swapDebtExpectedOut.toString(),
    'debt'
  );

  const swapInputs: SwapInputs = {
    inputAmountLamports: numberToLamportsDecimal(calcs.collToSwapIn, collReserve!.stats.decimals).ceil().toNumber(),
    inputMint: collTokenMint,
    outputMint: debtTokenMint,
  };

  // 3. Swap collateral to debt to repay flash loan
  const [swapIxns, lookupTablesAddresses] = await swapper(
    swapInputs.inputAmountLamports,
    swapInputs.inputMint,
    swapInputs.outputMint,
    slippagePct.toNumber()
  );

  const swapInstructions = removeBudgetAndAtaIxns(swapIxns, []);

  return {
    ixns: [
      ...budgetIxns,
      ...createAtasIxns,
      ...[flashBorrowIxn],
      ...repayAndWithdrawAction.setupIxs,
      ...[repayAndWithdrawAction.lendingIxs[0]],
      ...repayAndWithdrawAction.inBetweenIxs,
      ...[repayAndWithdrawAction.lendingIxs[1]],
      ...repayAndWithdrawAction.cleanupIxs,
      ...swapInstructions,
      ...[flashRepayIxn],
      ...closeAtasIxns,
    ],
    lookupTablesAddresses,
    swapInputs,
    totalKlendAccounts,
    initialInputs: {
      repayAmount,
      priceDebtToColl,
      slippagePct,
      currentSlot,
    },
  };
};
