import type BigNumber from 'bignumber.js';
import type { ContractTransaction, Signer } from 'ethers';

import { type VBnb, getVTokenContract } from 'libs/contracts';
import type { VToken } from 'types';

export interface SupplyInput {
  vToken: VToken;
  amountMantissa: BigNumber;
  signer: Signer;
}

export type SupplyOutput = ContractTransaction;

const supply = async ({ signer, vToken, amountMantissa }: SupplyInput): Promise<SupplyOutput> => {
  // Handle supplying BNB
  if (vToken.underlyingToken.isNative) {
    const tokenContract = getVTokenContract({
      vToken,
      signerOrProvider: signer,
    }) as VBnb;

    return tokenContract.mint({
      value: amountMantissa.toFixed(),
    });
  }

  // Handle supplying tokens other that BNB
  const tokenContract = getVTokenContract({ vToken, signerOrProvider: signer });
  return tokenContract.mint(amountMantissa.toFixed());
};

export default supply;
