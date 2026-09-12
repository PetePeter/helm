package com.potatomotato.helm.ble

import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothGattServer
import android.bluetooth.BluetoothGattServerCallback
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.BluetoothLeAdvertiser
import android.content.Context
import android.os.Build
import android.os.ParcelUuid
import com.potatomotato.helm.log.HelmLog

/**
 * GattServer — the Android half of the peripheral: advertiser plus GATT server.
 *
 * It deliberately decides nothing. Every framework callback is translated into
 * an event on [BleLinkSession], which owns ownership, backpressure, framing and
 * the retry curve, and which is tested on the JVM. Keep it that way: logic that
 * lands in this file is logic that can only be tested on a phone.
 *
 * Directions follow Helm's vocabulary, so they invert here — see [HelmGatt].
 */
@SuppressLint("MissingPermission") // Checked by BlePermissions before the service starts.
class GattServer(
    private val context: Context,
    private val log: (String) -> Unit = HelmLog.port(HelmLog.BLE),
) : GattPeripheral {

    private companion object {
        /** The radio's subsystem tag, so `adb logcat -s HelmBle:V` sees it all. */
        const val TAG = HelmLog.BLE
    }

    /** Set immediately after construction; the session needs this object first. */
    var session: BleLinkSession? = null

    private var gattServer: BluetoothGattServer? = null
    private var advertiser: BluetoothLeAdvertiser? = null
    private var txCharacteristic: BluetoothGattCharacteristic? = null

    /**
     * The advertisement is capped at 31 bytes and a 128-bit service UUID already
     * costs 18 of them, so the device name goes in the SCAN RESPONSE. An
     * arbitrarily long user device name can still overflow that, so the first
     * DATA_TOO_LARGE drops it and advertises bare.
     */
    private var includeNameInScanResponse = true

    /** Stand the GATT service up. False means the radio is unusable right now. */
    fun open(): Boolean {
        val manager = context.getSystemService(BluetoothManager::class.java) ?: return false
        val adapter = manager.adapter ?: return false
        if (!adapter.isEnabled) {
            log("bluetooth is off")
            return false
        }
        if (!adapter.isMultipleAdvertisementSupported) {
            log("this device cannot advertise as a peripheral")
            return false
        }

        advertiser = adapter.bluetoothLeAdvertiser ?: return false
        val server = manager.openGattServer(context, serverCallback) ?: return false
        gattServer = server
        server.addService(buildService())
        return true
    }

    fun close() {
        runCatching { advertiser?.stopAdvertising(advertiseCallback) }
        runCatching { gattServer?.close() }
        gattServer = null
        advertiser = null
        txCharacteristic = null
    }

    // ---- GattPeripheral ---------------------------------------------------

    override fun startAdvertising() {
        val advertiser = advertiser ?: run {
            session?.onAdvertiseFailed("no advertiser")
            return
        }

        val settings = AdvertiseSettings.Builder()
            // BALANCED, never LOW_LATENCY: this advertises all day and
            // LOW_LATENCY is a battery fire.
            .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_BALANCED)
            .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_MEDIUM)
            .setConnectable(true)
            .setTimeout(0)
            .build()

        val data = AdvertiseData.Builder()
            .setIncludeDeviceName(false)
            .addServiceUuid(ParcelUuid(HelmGatt.SERVICE_UUID))
            .build()

        val scanResponse = AdvertiseData.Builder()
            .setIncludeDeviceName(includeNameInScanResponse)
            .build()

        log("starting the advertiser, name in scan response: $includeNameInScanResponse")
        advertiser.startAdvertising(settings, data, scanResponse, advertiseCallback)
    }

    override fun stopAdvertising() {
        advertiser?.stopAdvertising(advertiseCallback)
    }

    override fun notifyTx(chunk: ByteArray): Boolean {
        val server = gattServer ?: run {
            log("cannot notify: there is no GATT server")
            return false
        }
        val characteristic = txCharacteristic ?: run {
            log("cannot notify: the TX characteristic is not built")
            return false
        }
        val device = connectedDevice() ?: run {
            log("cannot notify: no connected device holds the link")
            return false
        }

        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            server.notifyCharacteristicChanged(device, characteristic, false, chunk) ==
                BluetoothGatt.GATT_SUCCESS
        } else {
            @Suppress("DEPRECATION")
            characteristic.value = chunk
            @Suppress("DEPRECATION")
            server.notifyCharacteristicChanged(device, characteristic, false)
        }
    }

    override fun disconnect(centralAddress: String) {
        val server = gattServer ?: return
        val device = connectedDevices().firstOrNull { it.address == centralAddress } ?: return
        server.cancelConnection(device)
    }

    // ---- framework callbacks ----------------------------------------------

    private val advertiseCallback = object : AdvertiseCallback() {
        override fun onStartSuccess(settingsInEffect: AdvertiseSettings) {
            session?.onAdvertiseStarted()
        }

        override fun onStartFailure(errorCode: Int) {
            if (errorCode == ADVERTISE_FAILED_DATA_TOO_LARGE && includeNameInScanResponse) {
                // The user's device name does not fit; identity is established in
                // the handshake anyway, so advertise without it.
                includeNameInScanResponse = false
                startAdvertising()
                return
            }
            session?.onAdvertiseFailed("code $errorCode")
        }
    }

    private val serverCallback = object : BluetoothGattServerCallback() {
        /**
         * `status` is passed ON rather than dropped. It is the only thing that
         * says WHY a link ended, and discarding it is what made the churn
         * undiagnosable — see [GattStatus].
         */
        override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) {
            when (newState) {
                BluetoothProfile.STATE_CONNECTED -> session?.onCentralConnected(device.address, status)
                BluetoothProfile.STATE_DISCONNECTED -> session?.onCentralDisconnected(device.address, status)
                else -> HelmLog.d(TAG) { "connection state $newState, status ${GattStatus.describe(status)}" }
            }
        }

        override fun onMtuChanged(device: BluetoothDevice, mtu: Int) {
            session?.onMtuChanged(device.address, mtu)
        }

        override fun onServiceAdded(status: Int, service: BluetoothGattService) {
            log("GATT service added, status ${GattStatus.describe(status)}")
        }

        override fun onCharacteristicWriteRequest(
            device: BluetoothDevice,
            requestId: Int,
            characteristic: BluetoothGattCharacteristic,
            preparedWrite: Boolean,
            responseNeeded: Boolean,
            offset: Int,
            value: ByteArray,
        ) {
            if (characteristic.uuid == HelmGatt.RX_CHARACTERISTIC_UUID) {
                session?.onRxWrite(device.address, value)
            }
            if (responseNeeded) {
                gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, null)
            }
        }

        override fun onDescriptorWriteRequest(
            device: BluetoothDevice,
            requestId: Int,
            descriptor: BluetoothGattDescriptor,
            preparedWrite: Boolean,
            responseNeeded: Boolean,
            offset: Int,
            value: ByteArray,
        ) {
            if (descriptor.characteristic?.uuid == HelmGatt.TX_CHARACTERISTIC_UUID) {
                val subscribing = value.contentEquals(
                    BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE,
                )
                if (subscribing) {
                    session?.onTxSubscribed(device.address)
                } else {
                    session?.onTxUnsubscribed(device.address)
                }
            }
            if (responseNeeded) {
                gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, null)
            }
        }

        override fun onNotificationSent(device: BluetoothDevice, status: Int) {
            val ok = status == BluetoothGatt.GATT_SUCCESS
            // A refusal discards the REST of the message one layer up, so it is
            // never merely verbose — it is a silent truncation about to happen.
            if (!ok) log("the stack REFUSED a notification, status ${GattStatus.describe(status)}")
            session?.onNotificationSent(device.address, ok)
        }
    }

    // ---- service shape ----------------------------------------------------

    private fun buildService(): BluetoothGattService {
        val service = BluetoothGattService(
            HelmGatt.SERVICE_UUID,
            BluetoothGattService.SERVICE_TYPE_PRIMARY,
        )

        // RX: Helm writes, the phone receives. No response, so a central can
        // stream chunks without a round trip per chunk.
        service.addCharacteristic(
            BluetoothGattCharacteristic(
                HelmGatt.RX_CHARACTERISTIC_UUID,
                BluetoothGattCharacteristic.PROPERTY_WRITE or
                    BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE,
                BluetoothGattCharacteristic.PERMISSION_WRITE,
            ),
        )

        // TX: the phone notifies, Helm subscribes. Also the wake channel.
        val tx = BluetoothGattCharacteristic(
            HelmGatt.TX_CHARACTERISTIC_UUID,
            BluetoothGattCharacteristic.PROPERTY_NOTIFY,
            BluetoothGattCharacteristic.PERMISSION_READ,
        )
        tx.addDescriptor(
            BluetoothGattDescriptor(
                HelmGatt.CCC_DESCRIPTOR_UUID,
                BluetoothGattDescriptor.PERMISSION_READ or BluetoothGattDescriptor.PERMISSION_WRITE,
            ),
        )
        service.addCharacteristic(tx)
        txCharacteristic = tx

        // CTL is RESERVED. It is declared so the service shape matches the
        // contract Helm knows; dropping it is a wire break.
        service.addCharacteristic(
            BluetoothGattCharacteristic(
                HelmGatt.CTL_CHARACTERISTIC_UUID,
                BluetoothGattCharacteristic.PROPERTY_WRITE,
                BluetoothGattCharacteristic.PERMISSION_WRITE,
            ),
        )

        return service
    }

    private fun connectedDevices(): List<BluetoothDevice> =
        context.getSystemService(BluetoothManager::class.java)
            ?.getConnectedDevices(BluetoothProfile.GATT_SERVER)
            ?: emptyList()

    private fun connectedDevice(): BluetoothDevice? {
        val address = session?.centralAddress ?: return null
        return connectedDevices().firstOrNull { it.address == address }
    }
}
