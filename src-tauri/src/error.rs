//! Unified application error type.
//!
//! Tauri commands return `Result<T, AppError>`; `AppError` serializes to a plain
//! string so the frontend receives a human-readable message in the `Err` channel.
//! Because the frontend only sees that string, the leading text of AI/provider
//! messages is a cross-language contract: src/aiErrors.ts localizes them by
//! prefix, and aiErrors.test.ts raw-reads this file and ai.rs to keep both
//! sides in step.

use serde::{Serialize, Serializer};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("File I/O error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Data (JSON) error: {0}")]
    Serde(#[from] serde_json::Error),

    #[error("Network / API error: {0}")]
    Network(String),

    /// The provider answered 404 for the configured model (OpenRouter, or a
    /// body that names the model). Built only by `ai::map_provider_error`.
    /// The leading "Model unavailable: '<model>'" text is a contract with
    /// src/aiErrors.ts (MODEL_UNAVAILABLE_PREFIX), guarded on both sides.
    #[error("Model unavailable: '{model}' could not be served by the provider (HTTP 404). Choose another model in Settings. (provider: {detail})")]
    ModelUnavailable { model: String, detail: String },

    #[error("Keychain error: {0}")]
    Keyring(String),

    #[error("Configuration error: {0}")]
    Config(String),

    #[error("Unsupported file format: '{0}'")]
    UnsupportedFormat(String),

    #[error("Can't read image '{0}': unsupported image type. Use PNG, JPEG, GIF, WEBP, or BMP.")]
    UnsupportedImage(String),

    #[error("Can't read image '{name}': the file is {size_mb:.1} MB, over the {limit_mb} MB limit.")]
    ImageTooLarge {
        name: String,
        size_mb: f64,
        limit_mb: u64,
    },

    #[error("{0}")]
    Other(String),
}

/// Serialize as a flat string so `invoke(...).catch(e => ...)` yields the message.
impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

impl From<keyring::Error> for AppError {
    fn from(e: keyring::Error) -> Self {
        AppError::Keyring(e.to_string())
    }
}

impl From<reqwest::Error> for AppError {
    fn from(e: reqwest::Error) -> Self {
        AppError::Network(e.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;

#[cfg(test)]
mod tests {
    use super::*;

    // The leading "Model unavailable: '<id>'" text is a cross-language
    // contract: src/aiErrors.ts matches it (MODEL_UNAVAILABLE_PREFIX) to
    // localize the message and extract the model id. aiErrors.test.ts also
    // raw-reads this file, so a wording change fails on both sides.
    #[test]
    fn model_unavailable_names_the_model_and_keeps_the_provider_detail() {
        let e = AppError::ModelUnavailable {
            model: "meta-llama/llama-3.3-70b-instruct:free".into(),
            detail: "No endpoints found".into(),
        };
        let s = e.to_string();
        assert!(
            s.starts_with("Model unavailable: 'meta-llama/llama-3.3-70b-instruct:free' could not be served"),
            "got: {s}"
        );
        assert!(s.ends_with("(provider: No endpoints found)"), "got: {s}");
        // Serialized to the frontend as the same flat string.
        assert_eq!(serde_json::to_value(&e).expect("serialize"), serde_json::json!(s));
    }

    // `read_local_image_file` is reached from the image picker AND from the
    // preview / PPTX export resolving a document's figures, so the image
    // errors must not claim an insertion is happening.
    #[test]
    fn image_errors_use_wording_that_fits_every_caller() {
        assert_eq!(
            AppError::UnsupportedImage("fig.tiff".into()).to_string(),
            "Can't read image 'fig.tiff': unsupported image type. Use PNG, JPEG, GIF, WEBP, or BMP."
        );
        assert_eq!(
            AppError::ImageTooLarge { name: "big.png".into(), size_mb: 30.44, limit_mb: 25 }.to_string(),
            "Can't read image 'big.png': the file is 30.4 MB, over the 25 MB limit."
        );
    }
}
