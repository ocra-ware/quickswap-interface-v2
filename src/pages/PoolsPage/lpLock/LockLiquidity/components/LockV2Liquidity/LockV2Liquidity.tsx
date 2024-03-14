import React, { useCallback, useEffect, useState, useMemo } from 'react';
import {
  TransactionErrorContent,
  TransactionConfirmationModal,
  ConfirmationModalContent,
  NumericalInput,
} from 'components';
import { Contract } from '@ethersproject/contracts';
import { useTranslation } from 'react-i18next';
import { Token, ChainId } from '@uniswap/sdk';
import {
  useActiveWeb3React,
  useConnectWallet,
  useV2LiquidityPools,
} from 'hooks';
import { ApprovalState, useApproveCallback } from 'hooks/useApproveCallback';
import {
  calculateGasMargin,
  useIsSupportedNetwork,
  formatTokenAmount,
  getExactTokenAmount,
} from 'utils';
import {
  Box,
  Button,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  TextField,
} from '@material-ui/core';
import { useTokenBalance } from 'state/wallet/hooks';
import { usePairContract, useTokenLockerContract } from 'hooks/useContract';
import { V2_FACTORY_ADDRESSES } from 'constants/lockers';
import { updateUserLiquidityLock } from 'state/data/liquidityLocker';
import { tryParseAmount } from 'state/swap/hooks';
import useTransactionDeadline from 'hooks/useTransactionDeadline';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import { BigNumber, ethers, utils } from 'ethers';
import './index.scss';
dayjs.extend(utc);

const LockV2Liquidity: React.FC = () => {
  const { t } = useTranslation();
  const isSupportedNetwork = useIsSupportedNetwork();
  const { account, chainId, library } = useActiveWeb3React();
  const chainIdToUse = chainId ? chainId : ChainId.MATIC;

  // inputs
  const [unlockDate, setUnlockDate] = useState(dayjs().add(90, 'days'));
  const [selectedExtendDate, setSelectedExtendDate] = useState('3M');
  const [lpTokenAddress, setLpTokenAddress] = useState('');
  const [amount, setAmount] = useState('');
  const [selectedAmountPercentage, setSelectedAmountPercentage] = useState('');
  const [errorAmount, setErrorAmount] = useState(false);
  const [lockErrorMessage, setLockErrorMessage] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [feesInEth, setFeesInEth] = useState(ethers.BigNumber.from(0));

  const {
    loading: v2IsLoading,
    pairs: allV2PairsWithLiquidity,
  } = useV2LiquidityPools(account ?? undefined);

  const lpToken = useMemo(() => {
    return allV2PairsWithLiquidity.find(
      (item) => item.liquidityToken.address === lpTokenAddress,
    );
  }, [allV2PairsWithLiquidity, lpTokenAddress]);

  const userPoolBalance = useTokenBalance(
    account ?? undefined,
    lpToken?.liquidityToken,
  );
  const parsedAmount = tryParseAmount(
    chainIdToUse,
    amount,
    lpToken?.liquidityToken,
  );
  const tokenLockerContract = useTokenLockerContract(chainId);

  const [showConfirm, setShowConfirm] = useState(false);
  const [txHash, setTxHash] = useState('');
  const [txPending, setTxPending] = useState(false);
  const [approving, setApproving] = useState(false);
  const [attemptingTxn, setAttemptingTxn] = useState(false);
  const pairContract: Contract | null = usePairContract(
    lpToken?.liquidityToken?.address,
  );
  const [approval, approveCallback] = useApproveCallback(
    parsedAmount,
    chainId ? V2_FACTORY_ADDRESSES[chainId] : undefined,
  );

  const deadline = useTransactionDeadline();

  const handleChange = (e: any) => {
    setLpTokenAddress(e.target.value);
    setAmount('');
  };

  const onSetAmount = (inputAmount: string) => {
    setErrorAmount(Number(inputAmount) > getExactTokenAmount(userPoolBalance));
    setAmount(inputAmount);
    if (!userPoolBalance || !inputAmount || !lpToken) {
      setSelectedAmountPercentage('');
      return;
    }

    const formattedUserPoolBalance = BigNumber.from(
      userPoolBalance.raw.toString(),
    );
    const formatedAmount = utils.parseUnits(
      inputAmount,
      lpToken?.liquidityToken?.decimals,
    );
    const percentage = formatedAmount
      .mul(100)
      .div(formattedUserPoolBalance)
      .toString();
    setSelectedAmountPercentage(percentage);
  };

  const onPercentageClick = (percentage: string) => {
    if (!userPoolBalance) return;

    const formattedUserPoolBalance = BigNumber.from(
      userPoolBalance.raw.toString(),
    );
    setAmount(
      utils.formatUnits(
        formattedUserPoolBalance.mul(BigNumber.from(percentage)).div(100),
        lpToken?.liquidityToken?.decimals,
      ),
    );
    setSelectedAmountPercentage(percentage.toString());
  };

  const handleChangeDate = (e: string) => {
    setUnlockDate(dayjs(e));
  };

  const addMonths = (months: number) => {
    const newDate = dayjs().add(months, 'month');
    setUnlockDate(newDate);
    setSelectedExtendDate(`${months}M`);
  };

  const addYears = (years: number) => {
    const newDate = dayjs().add(years, 'year');
    setUnlockDate(newDate);
    setSelectedExtendDate(`${years}Y`);
  };

  useEffect(() => {
    async function getFeesInEth(address: string) {
      setFeesInEth(await tokenLockerContract?.getFeesInETH(address));
    }
    if (lpTokenAddress) {
      getFeesInEth(lpTokenAddress);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lpTokenAddress]);

  // @Hassaan: Approval already works
  const onAttemptToApprove = async () => {
    if (!pairContract || !lpToken || !library || !deadline) {
      setErrorMsg(t('missingdependencies'));
      return;
    }
    const liquidityAmount = parsedAmount;
    if (!liquidityAmount) {
      setErrorMsg(t('missingliquidity'));
      return;
    }
    setApproving(true);
    try {
      await approveCallback();
      setApproving(false);
    } catch (e) {
      setApproving(false);
    }
  };

  const onLock = async () => {
    if (
      !pairContract ||
      !lpToken ||
      !library ||
      !deadline ||
      v2IsLoading ||
      !tokenLockerContract
    ) {
      setErrorMsg(t('missingdependencies'));
      throw new Error(t('missingdependencies'));
    }
    const liquidityAmount = parsedAmount;

    if (!liquidityAmount) {
      setErrorMsg(t('missingliquidity'));
      throw new Error(t('missingliquidity'));
    }

    try {
      setAttemptingTxn(true);
      const gasEstimate = await tokenLockerContract?.estimateGas.lockToken(
        lpTokenAddress,
        account,
        parsedAmount.raw.toString(),
        unlockDate.unix(),
        false,
        ethers.constants.AddressZero,
      );
      const gasEstimateWithMargin = calculateGasMargin(gasEstimate);
      const response = await tokenLockerContract?.lockToken(
        lpTokenAddress,
        account,
        parsedAmount.raw.toString(),
        unlockDate.unix(),
        false,
        ethers.constants.AddressZero,
        {
          value: feesInEth,
          gasLimit: gasEstimateWithMargin,
        },
      );

      setTxHash(response.hash);
      setAttemptingTxn(false);
      setTxPending(true);

      const receipt = await response.wait();
      console.log(receipt);
      const depositId = await tokenLockerContract?.depositId();
      await updateUserLiquidityLock(V2_FACTORY_ADDRESSES[chainId], depositId);
      setTxPending(false);
    } catch (error) {
      setAttemptingTxn(false);
      setTxPending(false);
      setLockErrorMessage(t('errorInTx'));
    }
  };

  const handleDismissConfirmation = useCallback(() => {
    setShowConfirm(false);
    setTxHash('');
  }, []);

  const modalHeader = () => {
    return (
      <Box>
        <Box className='flex justify-center' mt={10} mb={3}>
          Locking V2 Liquidity
        </Box>
        <Box mt={2}>
          <Button fullWidth className='lockButton' onClick={onLock}>
            {t('confirm')}
          </Button>
        </Box>
      </Box>
    );
  };

  return (
    <Box>
      {showConfirm && (
        <TransactionConfirmationModal
          isOpen={showConfirm}
          onDismiss={handleDismissConfirmation}
          attemptingTxn={attemptingTxn}
          txPending={txPending}
          hash={txHash}
          content={() =>
            lockErrorMessage ? (
              <TransactionErrorContent
                onDismiss={handleDismissConfirmation}
                message={lockErrorMessage}
              />
            ) : (
              <ConfirmationModalContent
                title={t('lockingLiquidity')}
                onDismiss={handleDismissConfirmation}
                content={modalHeader}
              />
            )
          }
          pendingText=''
          modalContent={txPending ? 'Submitting' : 'Success'}
        />
      )}
      <Box p={2} className='bg-secondary2 rounded-md'>
        <Box mb={2}>
          <FormControl fullWidth variant='outlined'>
            <InputLabel>LP Token</InputLabel>
            <Select
              className='selectWrapper'
              disabled={v2IsLoading}
              value={lpTokenAddress}
              onChange={handleChange}
              label='LP Token'
              renderValue={() =>
                `${lpToken?.token0?.symbol}/${lpToken?.token1?.symbol}`
              }
            >
              <MenuItem value=''>
                <em>None</em>
              </MenuItem>
              {allV2PairsWithLiquidity.map((pair) => (
                <MenuItem
                  key={pair.liquidityToken.address}
                  value={pair.liquidityToken.address}
                >
                  {pair.liquidityToken.address}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        </Box>
        <Box className={`inputWrapper${errorAmount ? ' errorInput' : ''}`}>
          <NumericalInput
            value={amount}
            align='left'
            placeholder='0.00'
            onUserInput={(val) => {
              onSetAmount(val);
            }}
          />
        </Box>
        {errorAmount && (
          <small className='text-error'>
            {t('insufficientBalance', {
              symbol: `${lpToken?.token0?.symbol}/${lpToken?.token1?.symbol}`,
            })}
          </small>
        )}
        {userPoolBalance && (
          <Box className='flex justify-between items-center flex-wrap' mt={1}>
            <Box display='flex'>
              <small>{`${t('available')}:`}</small>
              <Box ml={0.5}>
                <small>{formatTokenAmount(userPoolBalance)}</small>
              </Box>
            </Box>
            <Box className='flex flex-wrap'>
              <Box
                className={`durationWrapper${
                  selectedAmountPercentage === '25'
                    ? ' selectedDurationWrapper'
                    : ''
                }`}
                onClick={() => onPercentageClick('25')}
              >
                <small>25%</small>
              </Box>
              <Box
                className={`durationWrapper${
                  selectedAmountPercentage === '50'
                    ? ' selectedDurationWrapper'
                    : ''
                }`}
                ml={1}
                onClick={() => onPercentageClick('50')}
              >
                <small>50%</small>
              </Box>
              <Box
                className={`durationWrapper${
                  selectedAmountPercentage === '75'
                    ? ' selectedDurationWrapper'
                    : ''
                }`}
                ml={1}
                onClick={() => onPercentageClick('75')}
              >
                <small>75%</small>
              </Box>
              <Box
                className={`durationWrapper${
                  selectedAmountPercentage === '100'
                    ? ' selectedDurationWrapper'
                    : ''
                }`}
                ml={1}
                onClick={() => onPercentageClick('100')}
              >
                <small>{t('max')}</small>
              </Box>
            </Box>
          </Box>
        )}
        <Box mt={2.5}>
          <TextField
            fullWidth
            label='Lock until'
            type='datetime-local'
            value={unlockDate.format('YYYY-MM-DDTHH:mm')}
            onChange={(e) => handleChangeDate(e.target.value)}
            InputLabelProps={{
              shrink: true,
            }}
          />
        </Box>
        <Box className='flex flex-wrap items-center flex-wrap' mt={1}>
          <Box
            className={`durationWrapper${
              selectedExtendDate === '3M' ? ' selectedDurationWrapper' : ''
            }`}
            onClick={() => addMonths(3)}
          >
            <small>3M</small>
          </Box>
          <Box
            className={`durationWrapper${
              selectedExtendDate === '6M' ? ' selectedDurationWrapper' : ''
            }`}
            onClick={() => addMonths(6)}
            ml={1}
          >
            <small>6M</small>
          </Box>
          <Box
            className={`durationWrapper${
              selectedExtendDate === '9M' ? ' selectedDurationWrapper' : ''
            }`}
            onClick={() => addMonths(9)}
            ml={1}
          >
            <small>9M</small>
          </Box>
          <Box
            className={`durationWrapper${
              selectedExtendDate === '1Y' ? ' selectedDurationWrapper' : ''
            }`}
            onClick={() => addYears(1)}
            ml={1}
          >
            <small>1Y</small>
          </Box>
          <Box
            className={`durationWrapper${
              selectedExtendDate === '2Y' ? ' selectedDurationWrapper' : ''
            }`}
            onClick={() => addYears(2)}
            ml={1}
          >
            <small>2Y</small>
          </Box>
          <Box
            className={`durationWrapper${
              selectedExtendDate === '5Y' ? ' selectedDurationWrapper' : ''
            }`}
            onClick={() => addYears(5)}
            ml={1}
          >
            <small>5Y</small>
          </Box>
        </Box>
      </Box>
      <Box className='swapButtonWrapper'>
        <Button
          fullWidth
          disabled={approving || approval !== ApprovalState.NOT_APPROVED}
          onClick={onAttemptToApprove}
        >
          {approving ? 'Approving...' : 'Approve'}
        </Button>
      </Box>
      <Box mt={2} className='swapButtonWrapper'>
        <Button
          fullWidth
          disabled={approval !== ApprovalState.APPROVED}
          onClick={() => {
            setLockErrorMessage('');
            setShowConfirm(true);
          }}
        >
          Lock Liquidity
        </Button>
      </Box>
    </Box>
  );
};

export default LockV2Liquidity;
