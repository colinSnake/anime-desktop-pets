import Foundation
import Security

// The process accepts exactly one bounded request on stdin. Validate it before
// any Security.framework call. Neither service nor keychain path is supplied.
let limit = 64 * 1024
let payloadLimit = 16 * 1024
let service = "local.anime-desktop-pets.models.v2"

func respond(_ status: String, secret: String? = nil, receipt: String? = nil) -> Never {
    var response: [String: Any] = ["version": 1, "status": status]
    if let secret { response["secret"] = secret }
    if let receipt { response["receipt"] = receipt }
    guard let bytes = try? JSONSerialization.data(withJSONObject: response, options: [.withoutEscapingSlashes]),
          bytes.count <= limit else { exit(1) }
    FileHandle.standardOutput.write(bytes)
    exit(0)
}

func isAccount(_ account: String) -> Bool {
    let prefix = "mcred-v1-"
    return account.hasPrefix(prefix) && account.utf8.count == prefix.utf8.count + 64 &&
        account.utf8.dropFirst(prefix.utf8.count).allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
}

var bytes = Data()
while bytes.count <= limit {
    let chunk = FileHandle.standardInput.readData(ofLength: min(4096, limit + 1 - bytes.count))
    if chunk.isEmpty { break }
    bytes.append(chunk)
}
guard CommandLine.arguments.count == 1, bytes.count <= limit,
      let input = (try? JSONSerialization.jsonObject(with: bytes)) as? [String: Any],
      let version = input["version"] as? NSNumber, CFGetTypeID(version) != CFBooleanGetTypeID(), version.doubleValue == 1,
      let operation = input["operation"] as? String, ["create", "read", "remove"].contains(operation),
      let account = input["account"] as? String, isAccount(account)
else { respond("unavailable") }
var allowed: Set = ["version", "operation", "account"]
let secret = input["secret"] as? String
let receipt: Data?
if operation == "create" {
    allowed.insert("secret")
    guard let secret, !secret.isEmpty, secret.utf8.count <= payloadLimit else { respond("unavailable") }
}
if operation == "remove" {
    allowed.insert("receipt")
    guard let encoded = input["receipt"] as? String, !encoded.isEmpty, encoded.utf8.count <= 4096,
          let decoded = Data(base64Encoded: encoded), decoded.base64EncodedString() == encoded else { respond("unavailable") }
    receipt = decoded
} else { receipt = nil }
guard Set(input.keys) == allowed else { respond("unavailable") }

// The file-based macOS keychain is used for the development helper. This
// process-local interaction setting intentionally fails rather than prompting.
var keychain: SecKeychain?
guard SecKeychainSetUserInteractionAllowed(false) == errSecSuccess,
      SecKeychainCopyDefault(&keychain) == errSecSuccess, let keychain else { respond("unavailable") }
let attributes: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: service,
    kSecAttrAccount as String: account,
]
var query = attributes
if operation == "create", let secret {
    query[kSecUseKeychain as String] = keychain
    query[kSecValueData as String] = Data(secret.utf8)
    query[kSecReturnPersistentRef as String] = true
    // SecItemAdd is add-only. Duplicate references never overwrite a key.
    var created: CFTypeRef?
    guard SecItemAdd(query as CFDictionary, &created) == errSecSuccess else { respond("unavailable") }
    guard let reference = created as? Data, !reference.isEmpty, reference.count <= 3072 else { respond("uncertain") }
    respond("ok", receipt: reference.base64EncodedString())
}
query[kSecMatchSearchList as String] = [keychain]
query[kSecMatchLimit as String] = kSecMatchLimitOne
query[(operation == "read" ? kSecReturnData : kSecReturnPersistentRef) as String] = true
var item: CFTypeRef?
let status = SecItemCopyMatching(query as CFDictionary, &item)
if status == errSecItemNotFound { respond("missing") }
guard status == errSecSuccess, let item else { respond("unavailable") }
if operation == "read" {
    guard let data = item as? Data, !data.isEmpty, data.count <= payloadLimit,
          let value = String(data: data, encoding: .utf8) else { respond("unavailable") }
    respond("ok", secret: value)
}
// Scope by namespace and current default, then verify the exact item receipt
// from add. A switched default cannot turn a missing match into confirmed cleanup.
guard let reference = item as? Data, reference == receipt else { respond("unavailable") }
let deletion: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecMatchItemList as String: [reference]]
let deleted = SecItemDelete(deletion as CFDictionary)
respond(deleted == errSecSuccess ? "ok" : deleted == errSecItemNotFound ? "missing" : "unavailable")
