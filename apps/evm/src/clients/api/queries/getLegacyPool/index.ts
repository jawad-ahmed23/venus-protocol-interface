import BigNumber from 'bignumber.js';

import type { PrimeApy } from 'types';
import {
  appendPrimeSimulationDistributions,
  convertAprToApy,
  extractSettledPromiseValue,
} from 'utilities';

import getLegacyPoolMarkets from '../getLegacyPoolMarkets';
import { formatToPool } from './formatToPool';
import type { GetLegacyPoolInput, GetLegacyPoolOutput } from './types';

export type { GetLegacyPoolInput, GetLegacyPoolOutput } from './types';

const getLegacyPool = async ({
  blocksPerDay,
  name,
  description,
  xvs,
  vai,
  tokens,
  accountAddress,
  legacyPoolComptrollerContract,
  venusLensContract,
  vaiControllerContract,
  resilientOracleContract,
  primeContract,
}: GetLegacyPoolInput): Promise<GetLegacyPoolOutput> => {
  const [
    marketsResult,
    mainMarkets,
    xvsPriceMantissaResult,
    primeVTokenAddressesResult,
    primeMinimumXvsToStakeResult,
    userPrimeTokenResult,
    assetsInResult,
    _accrueVaiInterestResult,
    vaiRepayAmountResult,
  ] = await Promise.allSettled([
    // Fetch all markets
    legacyPoolComptrollerContract.getAllMarkets(),
    // Fetch main markets to get the supplier and borrower counts
    // TODO: fetch borrower and supplier counts from subgraph once available
    getLegacyPoolMarkets({ xvs }),
    // Fetch XVS price
    resilientOracleContract.getPrice(xvs.address),
    // Prime related calls
    primeContract?.getAllMarkets(),
    primeContract?.MINIMUM_STAKED_XVS(),
    // Account related calls
    accountAddress ? primeContract?.tokens(accountAddress) : undefined,
    accountAddress ? legacyPoolComptrollerContract.getAssetsIn(accountAddress) : undefined,
    // Call (statically) accrueVAIInterest to calculate past accrued interests before fetching all
    // interests. Since multicall will batch these requests, the call to accrueVAIInterest and
    // getVAIRepayAmount will happen in the same request (thus making the accrual possible)
    accountAddress ? vaiControllerContract.callStatic.accrueVAIInterest() : undefined,
    accountAddress ? vaiControllerContract.getVAIRepayAmount(accountAddress) : undefined,
  ]);

  if (marketsResult.status === 'rejected') {
    throw new Error(marketsResult.reason);
  }

  if (xvsPriceMantissaResult.status === 'rejected') {
    throw new Error(xvsPriceMantissaResult.reason);
  }

  const vTokenAddresses = marketsResult.value;
  const primeVTokenAddresses = extractSettledPromiseValue(primeVTokenAddressesResult) || [];
  const primeMinimumXvsToStakeMantissa = extractSettledPromiseValue(primeMinimumXvsToStakeResult);
  const isUserPrime = extractSettledPromiseValue(userPrimeTokenResult)?.exists || false;

  // Fetch underlying token prices
  const underlyingTokenPricePromises = Promise.allSettled(
    vTokenAddresses.map(vTokenAddress => resilientOracleContract.getUnderlyingPrice(vTokenAddress)),
  );

  // Fetch vToken borrow and supply caps
  const borrowCapsPromises = Promise.allSettled(
    vTokenAddresses.map(vTokenAddress => legacyPoolComptrollerContract.borrowCaps(vTokenAddress)),
  );
  const supplyCapsPromises = Promise.allSettled(
    vTokenAddresses.map(vTokenAddress => legacyPoolComptrollerContract.supplyCaps(vTokenAddress)),
  );

  // Fetch vToken borrow and supply speeds
  const xvsBorrowSpeedPromises = Promise.allSettled(
    vTokenAddresses.map(vTokenAddress =>
      legacyPoolComptrollerContract.venusBorrowSpeeds(vTokenAddress),
    ),
  );
  const xvsSupplySpeedPromises = Promise.allSettled(
    vTokenAddresses.map(vTokenAddress =>
      legacyPoolComptrollerContract.venusSupplySpeeds(vTokenAddress),
    ),
  );

  // Fetch vToken meta data and user balance
  const vTokenMetaDataPromises = Promise.allSettled([
    // Fetch vToken data
    venusLensContract.callStatic.vTokenMetadataAll(vTokenAddresses),
    // Fetch user vToken balances
    accountAddress
      ? venusLensContract.callStatic.vTokenBalancesAll(vTokenAddresses, accountAddress)
      : undefined,
  ]);

  // Fetch Prime distributions
  const primeAprPromises =
    primeContract && isUserPrime
      ? Promise.allSettled(
          accountAddress
            ? primeVTokenAddresses.map(primeVTokenAddress =>
                primeContract.calculateAPR(primeVTokenAddress, accountAddress),
              )
            : [],
        )
      : undefined;

  const underlyingTokenPriceResults = await underlyingTokenPricePromises;
  const borrowCapsResults = await borrowCapsPromises;
  const supplyCapsResults = await supplyCapsPromises;
  const xvsBorrowSpeedResults = await xvsBorrowSpeedPromises;
  const xvsSupplySpeedResults = await xvsSupplySpeedPromises;
  const [vTokenMetaDataResults, userVTokenBalancesResults] = await vTokenMetaDataPromises;
  const primeAprResults = (await primeAprPromises) || [];

  if (vTokenMetaDataResults.status === 'rejected') {
    throw new Error(vTokenMetaDataResults.reason);
  }

  const primeApyMap = new Map<string, PrimeApy>();
  primeAprResults.forEach((primeAprResult, index) => {
    if (primeAprResult.status !== 'fulfilled') {
      return;
    }

    const primeApr = primeAprResult.value;

    const apys: PrimeApy = {
      borrowApy: convertAprToApy({ aprBips: primeApr?.borrowAPR.toString() || '0' }),
      supplyApy: convertAprToApy({ aprBips: primeApr?.supplyAPR.toString() || '0' }),
    };

    primeApyMap.set(primeVTokenAddresses[index], apys);
  });

  const vaiRepayAmountMantissa = extractSettledPromiseValue(vaiRepayAmountResult);

  const pool = formatToPool({
    blocksPerDay,
    name,
    xvs,
    vai,
    tokens,
    description,
    comptrollerContractAddress: legacyPoolComptrollerContract.address,
    vTokenMetaDataResults: vTokenMetaDataResults.value,
    underlyingTokenPriceResults,
    borrowCapsResults,
    supplyCapsResults,
    xvsBorrowSpeedResults,
    xvsSupplySpeedResults,
    xvsPriceMantissa: new BigNumber(xvsPriceMantissaResult.value.toString()),
    userCollateralizedVTokenAddresses: extractSettledPromiseValue(assetsInResult),
    userVTokenBalances: extractSettledPromiseValue(userVTokenBalancesResults),
    userVaiBorrowBalanceMantissa: vaiRepayAmountMantissa
      ? new BigNumber(vaiRepayAmountMantissa.toString())
      : undefined,
    primeApyMap,
    mainMarkets: extractSettledPromiseValue(mainMarkets)?.markets,
  });

  // Fetch Prime simulations and add them to distributions
  if (primeContract && primeMinimumXvsToStakeMantissa) {
    await appendPrimeSimulationDistributions({
      assets: pool.assets,
      primeContract,
      primeVTokenAddresses,
      accountAddress,
      primeMinimumXvsToStakeMantissa: new BigNumber(primeMinimumXvsToStakeMantissa.toString()),
      xvs,
    });
  }

  return {
    pool,
  };
};

export default getLegacyPool;
