//! Unified application error type.
//!
//! Tauri commands return `Result<T, AppError>`; `AppError` serializes to a plain
//! string so the frontend receives a human-readable message in the `Err` channel.

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

    #[error("Keychain error: {0}")]
    Keyring(String),

    #[error("Configuration error: {0}")]
    Config(String),

    #[error("Unsupported file format: '{0}'")]
    UnsupportedFormat(String),

    #[error("Can't insert '{0}': unsupported image type. Use PNG, JPEG, GIF, WEBP, or BMP.")]
    UnsupportedImage(String),

    #[error("Can't insert '{name}': the file is {size_mb:.1} MB, over the {limit_mb} MB limit.")]
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
