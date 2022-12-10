const { expect } = require("chai")
const { ethers } = require("hardhat")
const { utils, constants } = require("ethers");
const { createUniswap } = require("./helpers");

describe.only("SwappableBridge", function () {
	const mainnetId = 101
	const goerliEthId = 10121
	const sharedDecimals = 18;

	let owner, ownerAddressBytes32
	let ethUniswap, ethNativeOFT, ethOFT, weth, ethBridge, ethPool
	let goerliEthUniswap, goerliEthNativeOFT, goerliEthOFT, goerliWeth, goerliEthBridge, goerliEthPool

	before(async () => {
		[owner] = await ethers.getSigners();
		ownerAddressBytes32 = ethers.utils.defaultAbiCoder.encode(["address"], [owner.address]);
		const wethFactory = await ethers.getContractFactory("WETH9");
		weth = await wethFactory.deploy();
		ethUniswap = await createUniswap(owner, weth);

		goerliWeth = await wethFactory.deploy();
		goerliEthUniswap = await createUniswap(owner, goerliWeth);
	})

	beforeEach(async () => {
		const endpointFactory = await ethers.getContractFactory("LayerZeroEndpoint")
		const mainnetEndpoint = await endpointFactory.deploy(mainnetId);
		const goerliEndpoint = await endpointFactory.deploy(goerliEthId);
		
		const OFTFactory = await ethers.getContractFactory("OFTV2");
		ethOFT = await OFTFactory.deploy("ETH OFT", "ETH", sharedDecimals, goerliEndpoint.address);
		goerliEthOFT = await OFTFactory.deploy("Goerli ETH OFT", "ETH", sharedDecimals, mainnetEndpoint.address);

		const nativeOFTFactory = await ethers.getContractFactory("NativeOFTV2");
		ethNativeOFT = await nativeOFTFactory.deploy("ETH Native OFT", "ETH", sharedDecimals, mainnetEndpoint.address);
		goerliEthNativeOFT = await nativeOFTFactory.deploy("Goerli ETH Native OFT", "ETH", sharedDecimals, goerliEndpoint.address);

		const swappableBridgeFactory = await ethers.getContractFactory("SwappableBridge");
		ethBridge = await swappableBridgeFactory.deploy(goerliEthOFT.address, ethUniswap.router.address);
		goerliEthBridge = await swappableBridgeFactory.deploy(ethOFT.address, goerliEthUniswap.router.address);

		// internal bookkeeping for endpoints (not part of a real deploy, just for this test)
		await mainnetEndpoint.setDestLzEndpoint(ethOFT.address, goerliEndpoint.address);		
		await goerliEndpoint.setDestLzEndpoint(ethNativeOFT.address, mainnetEndpoint.address);

		await mainnetEndpoint.setDestLzEndpoint(goerliEthNativeOFT.address, goerliEndpoint.address);	
		await goerliEndpoint.setDestLzEndpoint(goerliEthOFT.address, mainnetEndpoint.address);

		await ethNativeOFT.setTrustedRemoteAddress(goerliEthId, ethOFT.address);
		await goerliEthNativeOFT.setTrustedRemoteAddress(mainnetId, goerliEthOFT.address);

		await goerliEthOFT.setTrustedRemoteAddress(goerliEthId, goerliEthNativeOFT.address);
		await ethOFT.setTrustedRemoteAddress(mainnetId, ethNativeOFT.address);
	})

	describe("bridges native Goerli ETH to mainnet", function () {
		const goerliAmount = utils.parseEther("10");		
		beforeEach(async () => {
			await goerliEthNativeOFT.deposit({ value: goerliAmount });
			const nativeFee = (await goerliEthNativeOFT.estimateSendFee(mainnetId, ownerAddressBytes32, goerliAmount, false, "0x")).nativeFee;
			await goerliEthNativeOFT.sendFrom(
				owner.address,
				mainnetId, // destination chainId
				ownerAddressBytes32, // destination address to send tokens to
				goerliAmount, // quantity of tokens to send (in units of wei)
				[owner.address, ethers.constants.AddressZero, "0x"], // adapterParameters empty bytes specifies default settings
				{ value: nativeFee.add(utils.parseEther("0.1")) } // pass a msg.value to pay the LayerZero message fee
			)
		})

		it("GoerliOFT is on mainnet", async () => {
			expect(await goerliEthOFT.balanceOf(owner.address)).to.be.equal(goerliAmount);
		})

		describe("creates ETH - ETH Goerli OFT pool on mainnet", function () {
			const liquidityAmount = utils.parseEther("10");
			beforeEach(async () => {				
				await goerliEthOFT.approve(ethUniswap.router.address, liquidityAmount);
				await ethUniswap.router.addLiquidityETH(goerliEthOFT.address, liquidityAmount, liquidityAmount, liquidityAmount, owner.address, 2e9, { value: liquidityAmount });
				ethPool = await ethUniswap.factory.getPair(weth.address, goerliEthOFT.address);
			})

			it("liquidity added", async () => {
				expect(await weth.balanceOf(ethPool)).to.be.equal(liquidityAmount);
				expect(await goerliEthOFT.balanceOf(ethPool)).to.be.equal(liquidityAmount);
			})

			describe("swaps and bridges to Goerli", function() {
				const amountIn = utils.parseEther("0.1");
				let amountOutMin;

				beforeEach(async () => {
					const amounts = await ethUniswap.router.getAmountsOut(amountIn, [weth.address, goerliEthOFT.address]);
					amountOutMin = amounts[1];
					await ethBridge.swapAndBridge(amountIn, amountOutMin, goerliEthId, [owner.address, constants.AddressZero, "0x"], { value: utils.parseEther("0.12") });
				})

				it("pool balances changed", async () => {
					expect(await weth.balanceOf(ethPool)).to.be.equal(liquidityAmount.add(amountIn));
					expect(await goerliEthOFT.balanceOf(ethPool)).to.be.equal(liquidityAmount.sub(amountOutMin));
				})
			})
		})
	})

	describe("bridges native ETH to Goerli ", function () {
		const ethAmount = utils.parseEther("11");
		beforeEach(async () => {
			await ethNativeOFT.deposit({ value: ethAmount });
			const nativeFee = (await ethNativeOFT.estimateSendFee(goerliEthId, ownerAddressBytes32, ethAmount, false, "0x")).nativeFee;
			await ethNativeOFT.sendFrom(
				owner.address,
				goerliEthId, // destination chainId
				ownerAddressBytes32, // destination address to send tokens to
				ethAmount, // quantity of tokens to send (in units of wei)
				[owner.address, ethers.constants.AddressZero, "0x"], // adapterParameters empty bytes specifies default settings
				{ value: nativeFee.add(utils.parseEther("0.1")) } // pass a msg.value to pay the LayerZero message fee
			)
		})

		it("EthOFT is on Goerli", async () => {
			expect(await ethOFT.balanceOf(owner.address)).to.be.equal(ethAmount);
		})

		describe("creates Goerli ETH - ETH OFT pool on Goerli", function () {
			const liquidityAmount = utils.parseEther("10");
			beforeEach(async () => {
				await ethOFT.approve(goerliEthUniswap.router.address, liquidityAmount);
				await goerliEthUniswap.router.addLiquidityETH(ethOFT.address, liquidityAmount, liquidityAmount, liquidityAmount, owner.address, 2e9, { value: liquidityAmount });
				goerliEthPool = await goerliEthUniswap.factory.getPair(goerliWeth.address, ethOFT.address);
			})

			it("liquidity added", async () => {
				expect(await goerliWeth.balanceOf(goerliEthPool)).to.be.equal(liquidityAmount);
				expect(await ethOFT.balanceOf(goerliEthPool)).to.be.equal(liquidityAmount);
			})

			describe("swaps and bridges to mainnet", function () {
				const amountIn = utils.parseEther("0.1");
				let amountOutMin;

				beforeEach(async () => {
					const amounts = await goerliEthUniswap.router.getAmountsOut(amountIn, [goerliWeth.address, ethOFT.address]);
					amountOutMin = amounts[1];
					await goerliEthBridge.swapAndBridge(amountIn, amountOutMin, mainnetId, [owner.address, constants.AddressZero, "0x"], { value: utils.parseEther("0.12") });
				})

				it("pool balances changed", async () => {
					expect(await goerliWeth.balanceOf(goerliEthPool)).to.be.equal(liquidityAmount.add(amountIn));
					expect(await ethOFT.balanceOf(goerliEthPool)).to.be.equal(liquidityAmount.sub(amountOutMin));
				})
			})
		})
	})
})
