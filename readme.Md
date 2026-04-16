git clone

```
https://github.com/Wawanahayy/nft
```
```
cd nft
````
install 
````
npm init -y
npm install ethers dotenv
````
go to .env change private key,RPC and contract
```
nano .env
```

### BLEVER MINT: GO TO WEB MINT INSCPECT click left or use CTRL + SHIFT + I
``dropId`` for UUID check on inscpect netwrok search


``x-csrf-token``for BLEVER_XCSRF check on inscpect netwrok search


``_csrfSecret`` for CSRF_SECRET go to inscpact aplication cookies check on value copy this


``BLEVER`` for COOKIE_BLEVER go to inscpact aplication cookies ``BLEVER`` check on value copy all this


## paste this on nano .env
```
PRIVATE_KEY=
CONTRACT_ADDRESS=
SEA_ADDRESS=0x00005EA00Ac477B1030CE78506496e8C2dE24bf5
FEE_RECIPIENT=0x0000a26b00c1F0DF003000390027140000fAa719
QTY=1
MINT_PRICE_ETH=0

#DELAY
DELAY_SEC=0
JITTER_SEC=0

#JIKA GAGAL / MINT BLM LIVE
RETRIES=100          # berapa kali retry kalau gagal (default 100)

#SOLANA private key
SECRET_KEY_B58=

# ===== BLEVER (auto-sign) =====
# Pilih salah satu identitas drop (UUID disarankan):
TO=                                      # (opsional)
DROP_UUID=
DROP_ID=     # (opsional fallback / nama slug /nama web)
BLEVER_XCSRF=AA...                       # nilai "x-csrf-token"
BLEVER_CSRF_SECRET=nk1ChV...%2F...       # nilai cookie "_csrfSecret" (don't delete URL-encoded, %2F etc)
BLEVER_COOKIE_BLEVER=Fe26.2*...          # nilai cookie "blever" (Long string Fe26.2*...)

```
Run all use input
```
node all.js
```

run opensea
```
node op.js
```

run magic eden
```
node me.js
```
run rari
```
node rari.js`
```
run DRIP
```
node drip.js
```
NEED MORE GASS TO SPEED AND NEED MORE IF REVERTED
```
node fcfs.js
```


SOL
```
npm i bs58 dotenv \
  @metaplex-foundation/umi \
  @metaplex-foundation/umi-bundle-defaults \
  @metaplex-foundation/mpl-candy-machine \
  @metaplex-foundation/mpl-token-metadata
```
run sol
```
node sol.js
```
