import { networks, PaymasterDetails } from '../config/networks'
import { getPaymasterAddressByTypeAndChain, PaymasterType } from '@opengsn/common'
import { GsnEvent, RelayProvider, environments, validateRelayUrl, GSNConfig } from '@opengsn/provider'
import { TokenPaymasterProvider } from '@opengsn/paymasters'

import { Contract, ethers, EventFilter, providers, Signer } from 'ethers'

import * as CtfArtifact from '../artifacts/contracts/CaptureTheFlag.sol/CaptureTheFlag.json'

declare let window: { ethereum: any, location: any }
declare let global: { network: any }

export interface EventInfo {
  date?: Date
  previousHolder: string
  currentHolder: string
}

export interface GsnStatusInfo {
  getActiveRelayers: () => Promise<number>
  getPaymasterBalance: () => Promise<string>
  relayHubAddress: string
  paymasterAddress: string
  forwarderAddress: string
  paymasterVersion: string
}

/**
 * a wrapper class for the CTF contract.
 * the only network-specific "leak" from this class is that the "capture()"
 * event returns a transaction object,
 * that the application should wait() until it gets mined.
 */
export class Ctf {
  ethersProvider: providers.Provider
  theContract: Contract

  blockDates: { [key: number]: Date } = {}

  constructor (
    readonly address: string,
    signer: Signer,
    readonly gsnProvider: RelayProvider,
    readonly chainId: number,
    readonly paymasterDetails: PaymasterDetails
  ) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    this.ethersProvider = signer.provider!

    this.gsnProvider = gsnProvider
    this.theContract = new ethers.Contract(address, CtfArtifact.abi, signer)
    this.blockDates = {}
  }

  async getCurrentFlagHolder (): Promise<string> {
    return this.theContract.currentHolder()
  }

  listenToEvents (onEvent: (e: EventInfo) => void, onProgress?: (e: GsnEvent) => void): void {
    // @ts-expect-error
    const listener = async (from, to, event): Promise<void> => {
      const info = await this.getEventInfo(event)
      onEvent(info)
    }
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    this.theContract.on('FlagCaptured', listener)
    if (onProgress != null) {
      this.gsnProvider.registerEventListener(onProgress)
    }
  }

  stopListenToEvents (onEvent?: EventFilter, onProgress = null): void {
    this.theContract.off(onEvent as any, null as any)
    this.gsnProvider.unregisterEventListener(onProgress as any)
  }

  async getBlockDate (blockNumber: number): Promise<Date> {
    if (this.blockDates[blockNumber] == null) {
      this.blockDates[blockNumber] = new Date(await this.ethersProvider.getBlock(blockNumber).then(b => {
        return b.timestamp * 1000
      }))
    }
    return this.blockDates[blockNumber]
  }

  async getEventInfo (e: ethers.Event): Promise<EventInfo> {
    if (e.args == null) {
      return {
        previousHolder: 'notevent',
        currentHolder: JSON.stringify(e)
      }
    }
    return {
      date: await this.getBlockDate(e.blockNumber),
      previousHolder: e.args.previousHolder,
      currentHolder: e.args.currentHolder
    }
  }

  async getPastEvents (count = 5): Promise<EventInfo[]> {
    const currentBlock = (await this.ethersProvider.getBlockNumber()) - 1
    // look at most one month back (in 12-second block
    const lookupWindow = global.network?.relayLookupWindowBlocks ?? 30 * 24 * 3600 / 12
    const startBlock = Math.max(1, currentBlock - lookupWindow)

    const logs = await this.theContract.queryFilter(this.theContract.filters.FlagCaptured(), startBlock)
      .catch(e => [])
    return await Promise.all(logs.slice(-count).map(async e => await this.getEventInfo(e)))
  }

  async getSigner (): Promise<string> {
    return await this.theContract.signer.getAddress()
  }

  async capture (): Promise<any> {
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    this.ethersProvider.getGasPrice().then(price => console.log('== gas price=', price.toString()))
    const gasFees = await this.gsnProvider.calculateGasFees()
    gasFees.maxPriorityFeePerGas = gasFees.maxFeePerGas
    console.log('gas fees=', gasFees)
    const gasLimit = 1e5
    const ret = await this.theContract.captureTheFlag({ gasLimit, ...gasFees })
    console.log('post-capture ret=', ret)
    return ret
  }

  async getGsnStatus (): Promise<GsnStatusInfo> {
    const relayClient = this.gsnProvider.relayClient
    const ci = relayClient.dependencies.contractInteractor as any
    return {
      relayHubAddress: ci.relayHubInstance.address,
      forwarderAddress: ci.forwarderInstance.address,
      paymasterAddress: ci.paymasterInstance.address,
      paymasterVersion: ci.paymasterVersion,

      getPaymasterBalance: () => ci.relayHubInstance.balanceOf(ci.paymasterInstance.address),
      getActiveRelayers: async () => await relayClient.dependencies.knownRelaysManager.refresh().then(() =>
        // count non-private relays
        relayClient.dependencies.knownRelaysManager.allRelayers.filter(r => validateRelayUrl(r.relayUrl)).length
      )
    }
  }

  async getPaymasterVersion (address: string): Promise<string> {
    const relayClient = this.gsnProvider.relayClient
    const ci = relayClient.dependencies.contractInteractor

    const pm = await ci._createPaymaster(address)
    const v = await pm.versionPaymaster()

    console.log('getPaymasterVersion', v)
    return v
  }
}

export async function switchNetwork (id: string): Promise<void> {
  // hexlify and even "hexlify(parseInt(id))" doesn't work for "5"
  const hexChain = '0x' + parseInt(id).toString(16)
  console.log('change network to ', hexChain)
  const provider = window.ethereum
  await provider.request({
    method: 'wallet_switchEthereumChain',
    params: [{ chainId: hexChain }]
  })
}

export function getNetworks (): { [chain: number]: string } {
  return Object.keys(networks)
    .map(key => parseInt(key))
    .filter(key => window.location.href.match(/local/) != null || (key !== 1337 && key !== 31337))
    .reduce((set, key) => ({ ...set, [key]: networks[key].name }), {})
}

export async function initCtf (paymasterDetails: PaymasterDetails): Promise<Ctf> {
  const web3Provider = window.ethereum

  if (web3Provider == null) { throw new Error('No "window.ethereum" found. do you have Metamask installed?') }

  web3Provider.on('chainChanged', (chainId: number) => {
    console.log('chainChanged', chainId)
    window.location.reload()
  })
  web3Provider.on('accountsChanged', (accs: any[]) => {
    console.log('accountChanged', accs)
    window.location.reload()
  })

  // TEMP: logging provider..
  // const orig=web3Provider
  // web3Provider = {
  //   send(r,cb) {
  //     const now = Date.now()
  //     console.log('>>> ',r)
  //     if ( r && r.params && r.params[0] && r.params[0].fromBlock == 1 ) {
  //       console.log('=== big wait!')
  //     }
  //     orig.send(r,(err,res)=>{
  //       console.log('<<<', Date.now()-now, err, res)
  //       cb(err,res)
  //     })
  //   }
  // }
  const provider = new ethers.providers.Web3Provider(web3Provider)
  const network = await provider.getNetwork()

  const chainId = network.chainId
  const net = global.network = networks[chainId]
  const netid: string = await provider.send('net_version', [])
  console.log('chainid=', chainId, 'networkid=', netid)
  if (chainId !== parseInt(netid)) { console.warn(`Incompatible network-id ${netid} and ${chainId}: for Metamask to work, they should be the same`) }
  if (net == null || net.paymasters.length === 0) {
    if (chainId.toString().match(/1337/) != null) {
      throw new Error('To run locally, you must run "yarn evm" and then "yarn deploy" before "yarn react-start" ')
    } else {
      throw new Error(`Unsupported network (chainId=${chainId}) . please switch to one of: ` + Object.values(networks).map((n: any) => n.name).filter(n => n).join(' / '))
    }
  }

  const gsnConfig: Partial<GSNConfig> = {
    loggerConfiguration: { logLevel: 'debug' },
    paymasterAddress: paymasterDetails.debugUseType ? paymasterDetails.paymasterType : paymasterDetails.address
  }

  if (chainId === 42161) { // changes for arbitrum
    gsnConfig.maxViewableGasLimit = 1e7.toString()
    gsnConfig.environment = environments.arbitrum
  }

  if (chainId === 43114) { // changes for avalanche
    gsnConfig.performDryRunViewRelayCall = false
  }

  console.log('== gsnconfig=', JSON.stringify(gsnConfig))
  let gsnProvider: RelayProvider
  switch (paymasterDetails.paymasterType) {
    case PaymasterType.AcceptEverythingPaymaster:
      gsnProvider = await RelayProvider.newWeb3Provider({ provider: web3Provider, config: gsnConfig })
      console.log('created new RelayProvider with config:', gsnConfig)
      break
    case PaymasterType.PermitERC20UniswapV3Paymaster:
      gsnProvider = TokenPaymasterProvider.newProvider({ provider: web3Provider, config: gsnConfig })
      console.log('created new TokenPaymasterProvider with config:', gsnConfig)
      break
    case PaymasterType.SingletonWhitelistPaymaster:
      gsnConfig.dappOwner = paymasterDetails.dappOwner
      gsnProvider = await RelayProvider.newWeb3Provider({ provider: web3Provider, config: gsnConfig })
      console.log('created new RelayProvider with config:', gsnConfig)
      break
    default:
      throw new Error(`Paymaster of type ${PaymasterType[paymasterDetails.paymasterType].toString()}(${paymasterDetails.paymasterType.toString()}) is not currently supported!`)
  }
  const provider2 = new ethers.providers.Web3Provider(gsnProvider)

  const signer = provider2.getSigner()

  return new Ctf(net.ctf, signer, gsnProvider, chainId, paymasterDetails)
}

export async function getSupportedPaymasters (): Promise<PaymasterDetails[]> {
  const web3Provider = window.ethereum

  const provider = new ethers.providers.Web3Provider(web3Provider)
  const network = await provider.getNetwork()

  const chainId = network.chainId
  console.log('getSupportedPaymasters', networks, chainId)
  const net = networks[chainId]
  return net.paymasters.map(paymasterDetails => {
    const paymasterAddress: string = paymasterDetails.address ?? getPaymasterAddressByTypeAndChain(paymasterDetails.paymasterType, chainId, console)
    if (paymasterAddress == null) {
      throw new Error(`CTF: Paymaster of type ${PaymasterType[paymasterDetails.paymasterType].toString()}(${paymasterDetails.paymasterType.toString()}) not found for chain ${chainId}`)
    }
    const paymasterName = paymasterDetails.name ?? PaymasterType[paymasterDetails.paymasterType] ?? 'unknown_pm_name'
    return {
      name: paymasterName,
      address: paymasterAddress,
      paymasterType: paymasterDetails.paymasterType,
      dappOwner: paymasterDetails.dappOwner,
      /** For debugging only - if set will not pass address to the GSN provider constructor */
      debugUseType: paymasterDetails.address == null
    }
  })
}
